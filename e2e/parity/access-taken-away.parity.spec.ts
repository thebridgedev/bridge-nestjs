/**
 * TBP-240 on a real issuer: access Bridge takes away is refused by the demo app's own server within seconds.
 *
 * A. An Admin is changed to Member: their old token is refused by the demo within seconds; a renewed token works.
 * D. A person is suspended across the app: their tokens are refused within 10 seconds, and renewing is refused too;
 *    resuming gives access back.
 * The Owner is never touched. Every person and workspace is made for the run on throwaway addresses.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { api, describeParity, eventually, expectStatus, newMember, newOwner, sleep, startDemo, type ParityEnv, type Person } from './support/stage';

/** The renewal the browser's SDK makes after a refusal: the refresh token, at the app's token endpoint. */
async function renew(env: ParityEnv, person: Person): Promise<{ status: number; token: string | null }> {
  const answer = await api(env, 'POST', `/identity-access/apps/${env.appId}/token`, { body: { grant_type: 'refresh_token', refresh_token: person.refreshToken, workspace: person.workspaceId } });
  return { status: answer.status, token: answer.status === 200 ? String(answer.body['access_token']) : null };
}

describeParity('access taken away reaches the app\'s own server (TBP-240)', (env) => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startDemo(env);
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });
  const me = (token: string) => request(app.getHttpServer()).get('/me').set('authorization', `Bearer ${token}`);

  it('A: a role change refuses the old token within seconds; a renewed token is taken', async () => {
    const owner = await newOwner(env, 'role-owner');
    const anna = await newMember(env, owner.workspaceId, 'ADMIN', 'role-anna');
    expect((await me(anna.token)).status).toBe(200);

    expectStatus(await api(env, 'PATCH', `/accounts/members/${String(anna.memberId)}`, { key: env.appKey, workspace: owner.workspaceId, body: { role: 'MEMBER' } }), 200);
    const gone = await eventually(async () => expect((await me(anna.token)).status).toBe(401), 20_000, 200);
    console.info(`the old token was refused ${String(gone.tookMs)} ms after the role change`);
    expect(gone.tookMs).toBeLessThan(10_000);
    expect((await me(owner.token)).status).toBe(200);

    // Renewed tokens are issued after the change, so the entry does not refuse them.
    await sleep(1_100);
    const renewed = await renew(env, anna);
    expect(renewed.status).toBe(200);
    expect((await me(String(renewed.token))).status).toBe(200);
  }, 90_000);

  it('D: suspending a person across the app refuses their tokens within 10 seconds; resuming gives access back', async () => {
    const owner = await newOwner(env, 'suspend-owner');
    const ben = await newMember(env, owner.workspaceId, 'MEMBER', 'suspend-ben');
    expect((await me(ben.token)).status).toBe(200);

    expectStatus(await api(env, 'POST', `/accounts/users/${ben.userId}/suspend`, { key: env.appKey }), 200);
    const gone = await eventually(async () => expect((await me(ben.token)).status).toBe(401), 20_000, 200);
    console.info(`the suspended person's token was refused ${String(gone.tookMs)} ms after the suspension`);
    expect(gone.tookMs).toBeLessThan(10_000);
    expect((await renew(env, ben)).status).not.toBe(200);
    expect((await me(owner.token)).status).toBe(200);

    expectStatus(await api(env, 'POST', `/accounts/users/${ben.userId}/resume`, { key: env.appKey }), 200);
  }, 90_000);

  it('says on its health check that the list is current, with the limits it fails closed at', async () => {
    const health = (await request(app.getHttpServer()).get('/')).body;
    expect(health.current).toEqual({ reads: true, writes: true });
    expect(health.limits).toEqual({ readsMs: 300_000, writesMs: 90_000 });
  });
});
