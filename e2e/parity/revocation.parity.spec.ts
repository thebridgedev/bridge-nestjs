/** A removed member's token is refused within seconds. */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BridgeManagementService } from '@nebulr-group/bridge-nestjs';
import { describeParity, eventually, newMember, newOwner, startDemo } from './support/stage';

describeParity('revocation', (env) => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await startDemo(env);
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });
  const me = (token: string) => request(app.getHttpServer()).get('/me').set('authorization', `Bearer ${token}`);

  it('refuses a member\'s token within seconds of removing them, and still takes the Owner\'s', async () => {
    const owner = await newOwner(env, 'revoke-owner');
    const member = await newMember(env, owner.workspaceId, 'MEMBER', 'revoke-member');
    expect((await me(member.token)).status).toBe(200);
    expect((await me(owner.token)).status).toBe(200);

    await app.get(BridgeManagementService).workspace(owner.workspaceId).members.remove(String(member.memberId));
    const gone = await eventually(async () => expect((await me(member.token)).status).toBe(401), 20_000, 200);
    console.info(`the removed member's token was refused ${String(gone.tookMs)} ms after the removal`);
    expect(gone.tookMs).toBeLessThan(15_000);
    expect((await me(owner.token)).status).toBe(200);
  }, 60_000);
});
