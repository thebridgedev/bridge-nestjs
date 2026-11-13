/** A route gated by a flag whose rule needs a plan feature: a workspace on a plan without it is refused with 402 and the feature's name, and let in when its plan has it. */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BridgeManagementService } from '@nebulr-group/bridge-nestjs';
import { api, describeParity, eventually, expectStatus, newOwner, setFlag, sleep, startDemo, type ParityEnv, type Person } from './support/stage';

const GATE = 'tickets-create';
const FEATURE = 'parity-export';
const METRIC = 'tickets.created';

/** Makes the route's flag, or changes it when it exists, so its rule is the plan feature's. */
async function gateOnPlanFeature(env: ParityEnv): Promise<void> {
  const body = {
    description: 'Parity suite: needs a plan feature',
    state: 'on-with-rule',
    rule: { branches: [{ conditions: [{ attribute: `bridge:billing.entitlement.${FEATURE}`, operator: 'eq', values: [true] }], returnValue: true }], otherwiseValue: false },
  };
  const made = await api(env, 'POST', '/flags/flags', { key: env.appKey, body: { key: GATE, ...body } });
  if (made.status === 201) return;
  if (made.status !== 409) expectStatus(made, 201);
  const current = expectStatus(await api(env, 'GET', `/flags/flags/${GATE}`, { key: env.appKey }), 200);
  expectStatus(await api(env, 'PATCH', `/flags/flags/${GATE}`, { key: env.appKey, body, headers: { 'if-match': current.headers.get('etag') ?? '' } }), 200);
}

/** A person's new token for the same session: a change to their workspace's plan refuses the tokens made before it. */
async function renewed(env: ParityEnv, person: Person): Promise<Person> {
  for (let attempt = 0; ; attempt += 1) {
    const answer = await api(env, 'POST', `/identity-access/apps/${env.appId}/token`, { body: { grant_type: 'refresh_token', refresh_token: person.refreshToken, workspace: person.workspaceId } });
    if (answer.status === 200) return { ...person, token: String(answer.body['access_token']), refreshToken: String(answer.body['refresh_token']), issuedAt: Date.now() };
    if (attempt >= 3) expectStatus(answer, 200);
    await sleep(3_500);
  }
}

describeParity('plan feature gate', (env) => {
  let app: INestApplication;
  let person: Person;
  /** One call as the person. A token made just before a plan change lands is refused once the change reaches it: the person signs in again, as an SDK does. */
  const create = async () => {
    for (let renewals = 0; ; renewals += 1) {
      const answer = await request(app.getHttpServer()).post('/tickets').set('authorization', `Bearer ${person.token}`).send({ title: 'Plan gate' });
      if (answer.status !== 401 || renewals >= 3) return answer;
      await sleep(3_500);
      person = await renewed(env, person);
    }
  };

  beforeAll(async () => {
    expectStatus(await api(env, 'PUT', `/billing/metrics/${METRIC}`, { key: env.appKey, body: { name: 'Tickets created', kind: 'counter' } }), 200, 201);
    await gateOnPlanFeature(env);
    app = await startDemo(env);
    person = await newOwner(env, 'plan');
  }, 60_000);

  afterAll(async () => {
    await setFlag(env, GATE, 'off');
    await app.close();
  });

  it('refuses a workspace whose plan lacks the feature with 402, naming the feature and where to upgrade, and lets it in once its plan has it', async () => {
    const workspace = app.get(BridgeManagementService).workspace(person.workspaceId);

    await workspace.setSubscription({ plan: 'parity-free' });
    person = await renewed(env, person);
    const refused = await eventually(async () => expect((await create()).status).toBe(402), 30_000, 1_000);
    const body = (await create()).body as Record<string, unknown>;
    expect(body).toMatchObject({ statusCode: 402, code: 'FEATURE_NOT_IN_PLAN', error: 'Payment Required', flag: GATE, feature: FEATURE, fix: expect.stringMatching(/^\//) });
    expect(String(body['message'])).toContain(FEATURE);

    await workspace.setSubscription({ plan: 'parity-pro' });
    person = await renewed(env, person);
    const allowed = await eventually(async () => expect((await create()).status).toBe(201), 30_000, 1_000);
    console.info(`402 on the free plan after ${String(refused.tookMs)} ms, 201 on the paid plan after ${String(allowed.tookMs)} ms`);
  }, 120_000);
});
