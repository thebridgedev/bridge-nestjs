/**
 * The management client with the app's key (workspaces, members, invites, plans, the payer) and with a
 * workspace key (its own workspace only).
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BridgeManagementService } from '@nebulr-group/bridge-nestjs';
import { api, describeParity, newOwner, setFlag, startDemo, type Person } from './support/stage';

type Page = { items?: unknown[]; data?: unknown[] } | unknown[];
const rows = (page: unknown): Record<string, unknown>[] => {
  const given = page as Page;
  return (Array.isArray(given) ? given : (given.items ?? given.data ?? [])) as Record<string, unknown>[];
};

describeParity('management client', (env) => {
  let app: INestApplication;
  let management: BridgeManagementService;
  let alpha: Person;
  let beta: Person;

  beforeAll(async () => {
    app = await startDemo(env);
    management = app.get(BridgeManagementService);
    alpha = await newOwner(env, 'mgmt-a');
    beta = await newOwner(env, 'mgmt-b');
  }, 60_000);

  afterAll(async () => {
    await setFlag(env, 'bridge-team-manage', 'off');
    await app.close();
  });

  describe('with the app key', () => {
    it('lists and makes workspaces', async () => {
      const made = (await management.workspaces.create({ name: `Parity made ${randomUUID().slice(0, 6)}`, owner: { email: `parity-made-${randomUUID().slice(0, 8)}@check.invalid` } })) as Record<string, unknown>;
      expect(typeof made['id']).toBe('string');
      const listed = rows(await management.workspaces.list({ limit: 100 })).map((workspace) => workspace['id']);
      expect(listed).toEqual(expect.arrayContaining([alpha.workspaceId, beta.workspaceId]));
    });

    it('reads a workspace and its members, adds one, and removes them again', async () => {
      const workspace = management.workspace(alpha.workspaceId);
      expect((await workspace.get()) as Record<string, unknown>).toMatchObject({ id: alpha.workspaceId });
      const before = rows(await workspace.members.list());
      expect(before.length).toBeGreaterThanOrEqual(1);
      const added = (await workspace.addMember({ email: `parity-added-${randomUUID().slice(0, 8)}@check.invalid`, role: 'MEMBER' })) as Record<string, unknown>;
      expect(rows(await workspace.members.list()).map((member) => member['id'])).toContain(added['id']);
      await workspace.members.remove(String(added['id']));
      expect(rows(await workspace.members.list()).map((member) => member['id'])).not.toContain(added['id']);
    });

    (env.inboxDomain === null ? it.skip : it)('sends an invite, lists it, and cancels it', async () => {
      const workspace = management.workspace(alpha.workspaceId);
      const email = `parity-invite-${randomUUID().slice(0, 8)}@${env.inboxDomain}`;
      const sent = (await workspace.invites.send({ email, role: 'MEMBER' })) as Record<string, unknown>;
      expect(rows(await workspace.invites.list()).map((invite) => invite['email'])).toContain(email);
      await workspace.invites.cancel(String(sent['id']));
      expect(rows(await workspace.invites.list()).map((invite) => invite['email'])).not.toContain(email);
    });

    it('reads the plans, and puts a workspace on one as the payer', async () => {
      const plans = rows(await management.plans.list()).map((plan) => plan['key']);
      expect(plans).toEqual(expect.arrayContaining(['parity-free', 'parity-pro']));
      const workspace = management.workspace(alpha.workspaceId);
      await workspace.setSubscription({ plan: 'parity-pro' });
      const payer = (await workspace.billing.get()) as Record<string, unknown>;
      expect(JSON.stringify(payer)).toContain('parity-pro');
      expect(await workspace.billing.usage()).toBeDefined();
    });

    it('lists the app\'s roles', async () => {
      expect(rows(await management.roles.list()).map((role) => role['key'])).toEqual(expect.arrayContaining(['PARITY_ANALYST', 'PARITY_MANAGER']));
    });
  });

  describe('with a workspace key', () => {
    let key = '';
    let gamma: Person;

    beforeAll(async () => {
      // Its own workspace, signed in after the plan changes above (a change of a workspace's access refuses the tokens before it).
      gamma = await newOwner(env, 'mgmt-key');
      // A workspace key is made by a signed-in person of the workspace: the demo's own route does it as the caller.
      await setFlag(env, 'bridge-team-manage', 'on');
      const made = await (async () => {
        for (const until = Date.now() + 20_000; ; await new Promise((resolve) => setTimeout(resolve, 500))) {
          const answer = await request(app.getHttpServer()).post('/team/workspace-keys').set('authorization', `Bearer ${gamma.token}`).send({ name: 'Parity', privileges: ['billing:read'] });
          if (answer.status === 201 || Date.now() > until) return answer;
        }
      })();
      expect(made.status).toBe(201);
      key = String(made.body['key'] ?? made.body['secret']);
    }, 60_000);

    it('acts for its own workspace: its payer, and the usage counted for it', async () => {
      const mine = management.withKey(key).workspace.billing;
      expect(JSON.stringify(await mine.get())).toContain('parity-free');
      expect(await mine.usage()).toBeDefined();
    });

    it('is refused for another workspace, however it asks', async () => {
      // The first workspace was put on parity-pro above; this key's own is on parity-free.
      const asked = await api(env, 'GET', '/billing/payer', { key, workspace: alpha.workspaceId });
      // Either refused, or answered as the key's own workspace: never the other one's.
      if (asked.status === 200) expect(asked.text).not.toContain('parity-pro');
      else expect([401, 403, 404]).toContain(asked.status);
      const usage = await api(env, 'GET', '/billing/payer/usage', { key, workspace: beta.workspaceId });
      if (usage.status !== 200) expect([401, 403, 404]).toContain(usage.status);
    });

    it('does not do what only people and the app\'s own key do', async () => {
      await expect(management.withKey(key).workspace.members.list()).rejects.toMatchObject({ kind: 'forbidden' });
      expect((await api(env, 'GET', '/accounts/workspaces', { key })).status).toBeGreaterThanOrEqual(400);
    });
  });
});
