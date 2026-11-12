/** A real person's token is accepted by the demo; forged, other-app, malformed and expired ones are refused. */
import type { INestApplication } from '@nestjs/common';
import { SignJWT, generateKeyPair } from 'jose';
import request from 'supertest';
import { BridgeService } from '@nebulr-group/bridge-nestjs';
import { describeParity, Harness, newOwner, sleep, startDemo, type Person } from './support/stage';

describeParity('tokens', (env) => {
  let app: INestApplication;
  let bridge: BridgeService;
  let person: Person;
  const me = (bearer?: string) => {
    const call = request(app.getHttpServer()).get('/me');
    return bearer === undefined ? call : call.set('authorization', `Bearer ${bearer}`);
  };

  beforeAll(async () => {
    app = await startDemo(env);
    bridge = app.get(BridgeService);
    person = await newOwner(env, 'tokens');
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('accepts a real person\'s token and knows who they are', async () => {
    const answer = await me(person.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ kind: 'person', appId: env.appId, personId: person.userId, workspaceId: person.workspaceId });
  });

  it('refuses no token and a malformed one', async () => {
    expect((await me()).status).toBe(401);
    expect((await me('not-a-token')).status).toBe(401);
  });

  it('refuses a token that looks like the app\'s but is signed by anyone else', async () => {
    const metadata = bridge.metadata();
    const { privateKey } = await generateKeyPair('PS256');
    const forged = await new SignJWT({ aid: metadata.appId, tid: person.workspaceId })
      .setProtectedHeader({ alg: 'PS256', kid: 'forged', typ: 'at+jwt' })
      .setIssuer(metadata.issuer)
      .setAudience(metadata.audience as string)
      .setSubject(person.userId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    expect((await me(forged)).status).toBe(401);
  });

  it('refuses a refresh token in place of an access token', async () => {
    expect((await me(person.refreshToken)).status).toBe(401);
  });

  (env.harness === null ? it.skip : it)('refuses a real token of another app', async () => {
    const other = await new Harness(env.harness as string).call<{ token: string }>('POST', '/other-app-token');
    expect((await me(other.token)).status).toBe(401);
  });

  // An access token lasts 5 minutes: this one is the person's own, from the start of the file, left until it has expired.
  (process.env['PARITY_FAST'] === '1' ? it.skip : it)('refuses a real token once it has expired', async () => {
    expect((await me(person.token)).status).toBe(200);
    await sleep(Math.max(0, person.issuedAt + 5 * 60_000 + 20_000 - Date.now()));
    expect((await me(person.token)).status).toBe(401);
  }, 400_000);
});
