import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BridgeService, webhookSignatureHeader } from '../src';
import { APP, createSignedIssuer, type SignedIssuer } from './support/signed-issuer';
import { eventually, startApp } from './support/test-app';

describe('BridgeModule against a signing issuer', () => {
  let issuer: SignedIssuer;
  let app: INestApplication;
  let token: string;

  beforeEach(async () => {
    issuer = await createSignedIssuer();
    app = await startApp(issuer);
    token = await issuer.personToken();
  });

  afterEach(async () => {
    await app.close();
  });

  const get = (path: string, bearer?: string) => {
    const call = request(app.getHttpServer()).get(path);
    return bearer === undefined ? call : call.set('authorization', `Bearer ${bearer}`);
  };

  describe('token checks', () => {
    it('refuses a protected route without a credential, with WWW-Authenticate', async () => {
      const answer = await get('/me');
      expect(answer.status).toBe(401);
      expect(answer.headers['www-authenticate']).toBe('Bearer');
    });

    it('gives the handler the verified Actor, with no role or privileges', async () => {
      const answer = await get('/me', token);
      expect(answer.status).toBe(200);
      expect(answer.body.actor).toEqual({
        kind: 'person',
        id: 'user-alice',
        personId: 'user-alice',
        workspaceId: 'ws-alpha',
        sessionId: 'sess-1',
        appId: APP,
        standing: 'active',
      });
      expect((await get('/workspace-id', token)).body).toEqual({ workspaceId: 'ws-alpha' });
    });

    it.each([
      ['an expired token', { expiresIn: Math.floor(Date.now() / 1000) - 60 }],
      ['another audience', { audience: 'https://elsewhere.example.test' }],
      ['another issuer', { issuer: 'https://bridge.example.test/identity-access/apps/app-other' }],
    ])('refuses %s', async (_, options) => {
      const bad = await issuer.personToken({}, options);
      const answer = await get('/me', bad);
      expect(answer.status).toBe(401);
      expect(answer.headers['www-authenticate']).toContain('invalid_token');
    });

    it('refuses a token for another app and a token that is not a JWT', async () => {
      expect((await get('/me', await issuer.personToken({ aid: 'app-other' }))).status).toBe(401);
      expect((await get('/me', 'not-a-token')).status).toBe(401);
    });

    it('opens a public route, ignoring a credential that does not check out', async () => {
      expect((await get('/public')).body).toEqual({ actor: null });
      expect((await get('/public', 'not-a-token')).body).toEqual({ actor: null });
      expect((await get('/public', token)).body.actor.personId).toBe('user-alice');
    });

    it('takes route rules: ANONYMOUS opens, AUTHENTICATED with a flag gates', async () => {
      expect((await get('/open/a/b')).status).toBe(200);
      expect((await get('/beta')).status).toBe(401);
      expect((await get('/beta', token)).status).toBe(403);
      issuer.setFlags('user-alice', [{ key: 'beta', value: true }]);
      expect((await get('/beta', token)).status).toBe(200);
    });

    // The router ignores case and a trailing slash; a rule must not be skipped where the router still runs the handler.
    const variants = ['/BETA', '/Beta', '/beta/', '/BETA/', '/%62eta', '/%62ETA', '//beta', '//beta/', '/beta//'];

    it('keeps a rule\'s flag gate whatever case, slashes or escapes the URL uses', async () => {
      for (const path of variants) {
        const answer = await get(path, token);
        expect({ path, status: answer.status }).toEqual({ path, status: answer.status === 404 ? 404 : 403 });
      }
      expect((await get('/BETA', token)).status).toBe(403);
      expect((await get('/beta/', token)).status).toBe(403);
      issuer.setFlags('user-alice', [{ key: 'beta', value: true }]);
      expect((await get('/BETA', token)).status).toBe(200);
    });

    it('matches a rule on the declared route, so a parameter route is gated for any URL', async () => {
      for (const path of ['/items/42', '/ITEMS/42', '/items/42/', '/Items/%34%32']) {
        expect({ path, status: (await get(path, token)).status }).toEqual({ path, status: 403 });
      }
    });

    it('keeps an AUTHENTICATED rule under defaultAccess public whatever the URL looks like', async () => {
      await app.close();
      app = await startApp(issuer, { guard: { global: true, defaultAccess: 'public', rules: [{ path: '/beta', privilege: 'AUTHENTICATED', featureFlag: 'beta' }] } });
      for (const path of ['/beta', ...variants]) {
        const status = (await get(path)).status;
        expect({ path, status }).toEqual({ path, status: status === 404 ? 404 : 401 });
      }
      expect((await get('/BETA')).status).toBe(401);
    });

    it('@AcceptAuth("jwt") refuses a call that brings only a key', async () => {
      const answer = await request(app.getHttpServer()).get('/people-only').set('x-api-key', 'some-key');
      expect(answer.status).toBe(401);
      expect((await get('/people-only', token)).status).toBe(200);
    });
  });

  describe('revocation within seconds', () => {
    it('refuses a token once its session is revoked', async () => {
      expect((await get('/me', token)).status).toBe(200);
      await issuer.revoke('identity-access', { kind: 'session', id: 'sess-1' });
      await eventually(async () => {
        const answer = await get('/me', token);
        expect(answer.status).toBe(401);
        expect(answer.body.code).toBe('revoked');
      });
    });

    it('refuses a removed member', async () => {
      expect((await get('/me', token)).status).toBe(200);
      await issuer.revoke('accounts', { kind: 'person', id: 'user-alice' });
      await eventually(async () => expect((await get('/me', token)).status).toBe(401));
    });

    it('answers 503 for writes, never yes, once the list falls too far behind', async () => {
      await app.close();
      app = await startApp(issuer, { strictLagMs: 300, maxLagMs: 60_000 });
      expect((await request(app.getHttpServer()).post('/notes').set('authorization', `Bearer ${token}`).send({ a: 1 })).status).toBe(201);
      issuer.setLanesDown(true);
      await eventually(async () => {
        const answer = await request(app.getHttpServer()).post('/notes').set('authorization', `Bearer ${token}`).send({ a: 1 });
        expect(answer.status).toBe(503);
        expect(answer.headers['retry-after']).toBe('5');
      });
      // A read, and a write marked @Strict(false), still pass within the normal lag.
      expect((await get('/me', token)).status).toBe(200);
      expect((await request(app.getHttpServer()).post('/relaxed').set('authorization', `Bearer ${token}`)).status).toBe(201);
    });

    it('answers 503 for reads too, never yes, once the list falls behind maxLagMs', async () => {
      await app.close();
      app = await startApp(issuer, { strictLagMs: 100, maxLagMs: 300 });
      expect((await get('/me', token)).status).toBe(200);
      issuer.setLanesDown(true);
      await eventually(async () => {
        const answer = await get('/me', token);
        expect(answer.status).toBe(503);
        expect(answer.headers['retry-after']).toBe('5');
      });
      expect((await get('/reports', token)).status).toBe(503);
      expect((await get('/public')).body).toEqual({ actor: null });
    });
  });

  describe('flag gates', () => {
    it('lets the call through when the flag is on', async () => {
      issuer.setFlags('user-alice', [{ key: 'reports', value: true }]);
      expect((await get('/reports', token)).status).toBe(200);
    });

    it('answers 402 FEATURE_NOT_IN_PLAN when a plan feature keeps it off', async () => {
      issuer.setFlags('user-alice', [{ key: 'reports', value: false, reason: 'TARGETING_MATCH', metadata: { entitlement: 'reports', why: 'plan' } }]);
      const answer = await get('/reports', token);
      expect(answer.status).toBe(402);
      expect(answer.body).toMatchObject({ code: 'FEATURE_NOT_IN_PLAN', flag: 'reports', feature: 'reports', fix: '/subscription' });
    });

    it('answers 403 FEATURE_OFF otherwise, and when Bridge gave no result', async () => {
      issuer.setFlags('user-alice', [{ key: 'reports', value: false }]);
      expect((await get('/reports', token)).body).toMatchObject({ statusCode: 403, code: 'FEATURE_OFF', flag: 'reports' });
      issuer.setFlags('user-alice', []);
      expect((await get('/reports', token)).status).toBe(403);
    });

    it('takes any and all', async () => {
      issuer.setFlags('user-alice', [
        { key: 'reports', value: false },
        { key: 'reports-beta', value: true },
        { key: 'export', value: true },
      ]);
      expect((await get('/reports-any', token)).status).toBe(200);
      expect((await get('/reports-all', token)).body).toMatchObject({ code: 'FEATURE_OFF', flag: 'reports' });
    });

    it('gives a flag value and the whole set to a handler', async () => {
      issuer.setFlags('user-alice', [
        { key: 'page-size', value: 50 },
        { key: 'reports', value: true },
      ]);
      expect((await get('/page-size', token)).body).toEqual({ size: 50, reports: true, viaService: true });
    });

    it('refuses a flag-reading handler whose caller does not check out', async () => {
      expect((await get('/page-size', 'not-a-token')).status).toBe(401);
    });
  });

  describe('count this', () => {
    it('counts usage for the caller\'s workspace once the handler succeeds', async () => {
      await request(app.getHttpServer()).post('/tickets').set('authorization', `Bearer ${token}`).expect(201);
      await app.get(BridgeService).flush();
      expect(issuer.usage).toEqual([expect.objectContaining({ metric: 'tickets.created', quantity: 1, workspace: 'ws-alpha' })]);
    });
  });

  describe('webhooks', () => {
    const body = JSON.stringify({ type: 'workspace.created', data: { id: 'ws-1' } });
    const send = (signature: string) =>
      request(app.getHttpServer())
        .post('/webhooks/bridge')
        .set('content-type', 'application/json')
        .set('bridge-signature', signature)
        .set('bridge-event-id', 'evt-1')
        .set('bridge-event-type', 'workspace.created')
        .send(body);

    it('takes a delivery signed with either secret during the overlap', async () => {
      for (const secrets of [['whsec_new'], ['whsec_old'], ['whsec_new', 'whsec_old']]) {
        const answer = await send(webhookSignatureHeader(secrets, body));
        expect(answer.status).toBe(201);
        expect(answer.body.event).toMatchObject({ id: 'evt-1', type: 'workspace.created', payload: { data: { id: 'ws-1' } } });
      }
    });

    it('refuses a wrong secret, a changed body and an old signature', async () => {
      expect((await send(webhookSignatureHeader('whsec_other', body))).status).toBe(401);
      expect((await send(webhookSignatureHeader('whsec_new', `${body} `))).status).toBe(401);
      expect((await send(webhookSignatureHeader('whsec_new', body, Math.floor(Date.now() / 1000) - 3600))).status).toBe(401);
      expect((await request(app.getHttpServer()).post('/webhooks/bridge').send(body)).status).toBe(401);
    });
  });

  describe('management client', () => {
    it('calls the issuer\'s accounts endpoint with the app key, naming the workspace', async () => {
      issuer.answer('GET', '/v2/accounts/members', { body: { items: [{ id: 'm-1' }] } });
      const answer = await get('/admin/members', token);
      expect(answer.body).toEqual({ items: [{ id: 'm-1' }] });
      const call = issuer.calls.find((each) => each.url.endsWith('/v2/accounts/members'));
      expect(call?.headers['x-api-key']).toBe('app-key-for-tests');
      expect(call?.headers['bridge-workspace']).toBe('ws-alpha');
      expect(call?.headers['authorization']).toBeUndefined();
    });
  });
});
