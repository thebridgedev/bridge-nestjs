/**
 * The demo app, end to end, over HTTP.
 *
 * Always: against a signing issuer in memory (tokens signed as Bridge signs
 * them, the four revocation lanes, flags, usage), so every path runs, revocation
 * included.
 *
 * With E2E_ISSUER (a real issuer, such as a test app on stage): token checks
 * against the real metadata, key set and revocation list. Add
 * E2E_ACCESS_TOKEN (a person's token for that app, from a sign-in, never
 * committed) to check the signed-in path too.
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SignJWT, generateKeyPair } from 'jose';
import request from 'supertest';
import { BRIDGE_OPTIONS, BridgeService, webhookSignatureHeader, type BridgeModuleOptions } from '@nebulr-group/bridge-nestjs';
import { AppModule } from '../demo/src/app.module';
import { received } from '../demo/src/webhooks.controller';
import { createSignedIssuer, type SignedIssuer } from '../bridge-nestjs/test/support/signed-issuer';

async function startDemo(options: BridgeModuleOptions): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(BRIDGE_OPTIONS).useValue(options).compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  await app.init();
  return app;
}

async function eventually(check: () => Promise<void>, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe('demo app against a signing issuer', () => {
  let issuer: SignedIssuer;
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    issuer = await createSignedIssuer();
    app = await startDemo({
      issuer: issuer.issuer,
      appKey: 'app-key-for-tests',
      fetch: issuer.fetch,
      revocationIntervalMs: 50,
      usageFlushMs: 20,
      webhookSecrets: ['whsec_demo'],
      guard: { global: true },
    });
    await app.get(BridgeService).ready;
    token = await issuer.personToken();
  });

  afterAll(async () => {
    await app.close();
  });

  const as = (bearer: string) => ({
    get: (path: string) => request(app.getHttpServer()).get(path).set('authorization', `Bearer ${bearer}`),
    post: (path: string, body: object = {}) => request(app.getHttpServer()).post(path).set('authorization', `Bearer ${bearer}`).send(body),
  });

  it('serves its health check to everyone, once the revocation list is current', async () => {
    await eventually(async () => {
      const answer = await request(app.getHttpServer()).get('/');
      expect(answer.body.revocationList.ready).toBe(true);
    });
  });

  it('knows the caller', async () => {
    expect((await request(app.getHttpServer()).get('/me')).status).toBe(401);
    expect((await as(token).get('/me')).body).toMatchObject({ kind: 'person', personId: 'user-alice', workspaceId: 'ws-alpha' });
  });

  it('gates tickets with flags, and counts each one made', async () => {
    issuer.setFlags('user-alice', [{ key: 'tickets-create', value: false, metadata: { entitlement: 'tickets' } }]);
    expect((await as(token).get('/tickets')).body).toMatchObject({ statusCode: 403, code: 'FEATURE_OFF' });
    expect((await as(token).post('/tickets', { title: 'One' })).body).toMatchObject({ statusCode: 402, code: 'FEATURE_NOT_IN_PLAN', feature: 'tickets' });

    issuer.setFlags('user-alice', [
      { key: 'tickets', value: true },
      { key: 'tickets-create', value: true },
      { key: 'tickets-page-size', value: 1 },
    ]);
    expect((await as(token).post('/tickets', { title: 'One' })).status).toBe(201);
    expect((await as(token).post('/tickets', { title: 'Two' })).status).toBe(201);
    expect((await as(token).get('/tickets')).body).toEqual([{ id: 1, workspace: 'ws-alpha', title: 'One' }]);
    await app.get(BridgeService).flush();
    expect(issuer.usage.filter((report) => (report as { metric: string }).metric === 'tickets.created')).toHaveLength(2);
  });

  it('manages the team as the caller, with their token', async () => {
    issuer.setFlags('user-alice', [{ key: 'bridge-team-manage', value: true }]);
    issuer.answer('POST', '/v2/identity-access/workspace-keys', { status: 201, body: { id: 'key-1', name: 'CI', secret: 'shown-once' } });
    expect((await as(token).get('/team/members')).status).toBe(200);
    expect((await as(token).post('/team/workspace-keys', { name: 'CI' })).body).toMatchObject({ id: 'key-1' });
    const keyCall = issuer.calls.find((call) => call.url.endsWith('/v2/identity-access/workspace-keys'));
    expect(keyCall?.headers['authorization']).toBe(`Bearer ${token}`);
  });

  it('receives a signed webhook and refuses an unsigned one', async () => {
    const body = JSON.stringify({ type: 'member.added', data: { id: 'm-1' } });
    const send = (signature?: string) => {
      const call = request(app.getHttpServer()).post('/webhooks/bridge').set('content-type', 'application/json').set('bridge-event-id', 'evt-9');
      return (signature === undefined ? call : call.set('bridge-signature', signature)).send(body);
    };
    expect((await send()).status).toBe(401);
    expect((await send(webhookSignatureHeader('whsec_demo', body))).status).toBe(204);
    expect((await send(webhookSignatureHeader('whsec_demo', body))).status).toBe(204);
    expect(received.filter((event) => event.id === 'evt-9')).toHaveLength(1);
  });

  it('refuses the caller within seconds once their session ends', async () => {
    expect((await as(token).get('/me')).status).toBe(200);
    await issuer.revoke('identity-access', { kind: 'session', id: 'sess-1' });
    await eventually(async () => expect((await as(token).get('/me')).status).toBe(401));
  });
});

const realIssuer = process.env.E2E_ISSUER;
(realIssuer ? describe : describe.skip)('demo app against a real issuer (E2E_ISSUER)', () => {
  let app: INestApplication;
  let bridge: BridgeService;

  beforeAll(async () => {
    app = await startDemo({ issuer: realIssuer as string, guard: { global: true } });
    bridge = app.get(BridgeService);
    await bridge.ready;
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  it('reads the issuer\'s metadata and follows every lane of its revocation list', async () => {
    const metadata = bridge.metadata();
    expect(metadata.audience).toBeTruthy();
    expect(Object.keys(metadata.revocationLanes).sort()).toEqual(['accounts', 'app-registry', 'billing', 'identity-access']);
    await eventually(async () => expect(bridge.status()?.ready).toBe(true), 20_000);
    expect((await request(app.getHttpServer()).get('/')).body.revocationList.ready).toBe(true);
  }, 30_000);

  it('refuses no token, a malformed one, and one signed by anyone but the issuer', async () => {
    expect((await request(app.getHttpServer()).get('/me')).status).toBe(401);
    expect((await request(app.getHttpServer()).get('/me').set('authorization', 'Bearer not-a-token')).status).toBe(401);
    const metadata = bridge.metadata();
    const { privateKey } = await generateKeyPair('PS256');
    const forged = await new SignJWT({ aid: metadata.appId, tid: 'ws-forged' })
      .setProtectedHeader({ alg: 'PS256', kid: 'forged', typ: 'at+jwt' })
      .setIssuer(metadata.issuer)
      .setAudience(metadata.audience as string)
      .setSubject('user-forged')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const answer = await request(app.getHttpServer()).get('/me').set('authorization', `Bearer ${forged}`);
    expect(answer.status).toBe(401);
  });

  (process.env.E2E_ACCESS_TOKEN ? it : it.skip)('takes a real person\'s token (E2E_ACCESS_TOKEN)', async () => {
    const answer = await request(app.getHttpServer()).get('/me').set('authorization', `Bearer ${process.env.E2E_ACCESS_TOKEN}`);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ kind: 'person', appId: bridge.metadata().appId });
  });
});
