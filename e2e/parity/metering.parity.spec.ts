/** "Count this" (BridgeMeterInterceptor): what a route counts reaches Billing's usage for the caller's workspace. */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BridgeManagementService, BridgeService } from '@nebulr-group/bridge-nestjs';
import { api, describeParity, eventually, newOwner, setFlag, startDemo, expectStatus, type Person } from './support/stage';

const METRIC = 'tickets.created';

describeParity('usage metering', (env) => {
  let app: INestApplication;
  let person: Person;

  beforeAll(async () => {
    // The metric and the flags the demo's route needs: made by the app's server, as an app does at setup.
    const metric = await api(env, 'PUT', `/billing/metrics/${METRIC}`, { key: env.appKey, body: { name: 'Tickets created', kind: 'counter' } });
    expectStatus(metric, 200, 201);
    await setFlag(env, 'tickets-create', 'on');
    app = await startDemo(env);
    person = await newOwner(env, 'meter');
  }, 60_000);

  afterAll(async () => {
    await setFlag(env, 'tickets-create', 'off');
    await app.close();
  });

  const usedOf = async (): Promise<number> => {
    const usage = JSON.stringify(await app.get(BridgeManagementService).workspace(person.workspaceId).billing.usage());
    const found = new RegExp(`"(?:metric|key)":"${METRIC.replace('.', '\\.')}"[^}]*?"(?:used|count|value|total|quantity)":(\\d+)`).exec(usage);
    return found === null ? 0 : Number(found[1]);
  };

  it('counts each ticket made and shows the count in the workspace\'s usage', async () => {
    const before = await usedOf();
    for (let made = 0; made < 3; made += 1) {
      const answer = await request(app.getHttpServer()).post('/tickets').set('authorization', `Bearer ${person.token}`).send({ title: `T${String(made)}` });
      expect(answer.status).toBe(201);
    }
    await app.get(BridgeService).flush();
    const reached = await eventually(async () => expect(await usedOf()).toBe(before + 3), 30_000, 1_000);
    console.info(`3 counted tickets reached Billing's usage in ${String(reached.tookMs)} ms`);
  }, 90_000);
});
