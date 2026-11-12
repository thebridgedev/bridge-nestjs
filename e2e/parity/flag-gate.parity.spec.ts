/** A route gated by a feature flag: off refuses with the flag's name, on lets the person in within seconds, off again refuses. */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describeParity, eventually, newOwner, setFlag, startDemo, type Person } from './support/stage';

describeParity('flag gate', (env) => {
  let app: INestApplication;
  let person: Person;
  const tickets = () => request(app.getHttpServer()).get('/tickets').set('authorization', `Bearer ${person.token}`);

  beforeAll(async () => {
    await setFlag(env, 'tickets', 'off');
    app = await startDemo(env);
    person = await newOwner(env, 'flag');
  }, 60_000);

  afterAll(async () => {
    await setFlag(env, 'tickets', 'off');
    await app.close();
  });

  it('refuses the route while its flag is off, and names the flag', async () => {
    const answer = await tickets();
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ code: 'FEATURE_OFF', flag: 'tickets' });
  });

  it('lets the person in within seconds of the flag going on, and out again when it goes off', async () => {
    await setFlag(env, 'tickets', 'on');
    const on = await eventually(async () => expect((await tickets()).status).toBe(200), 20_000);
    await setFlag(env, 'tickets', 'off');
    const off = await eventually(async () => expect((await tickets()).status).toBe(403), 20_000);
    console.info(`flag on reached the demo in ${String(on.tookMs)} ms, off in ${String(off.tookMs)} ms`);
  }, 60_000);
});
