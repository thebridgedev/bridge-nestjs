/**
 * E2E: plan limits as decorators (TBP-704), against a real bridge-api.
 *
 * The demo TicketsController carries:
 *   POST   /tickets             @RequireQuota('tickets', { current })   — gauge
 *   DELETE /tickets/:id         @SyncQuota('tickets', { current })
 *   POST   /tickets/:id/export  @RequireQuota('exports') — counter
 *
 * Every request is a direct HTTP call with a real user token, i.e. exactly
 * what a caller bypassing the UI sends. What the plugin wrote to Bridge is read
 * back from Bridge itself (`GET /usage/quota/:metric`), never from the plugin.
 *
 * Setup: a fresh workspace per run, on a plan whose quotas this suite owns
 * (`tickets` gauge hard 2, `exports` counter hard 50). Quotas are written with
 * a minted management API token, as the CLI / MCP would.
 */

import { INestApplication } from '@nestjs/common';
import supertest from 'supertest';
import { createTestApp } from './_helpers/app-factory';
import { TestDataClient, PlaywrightTestAccount } from '../utils/test-data-client';
import { AuthClient } from '../utils/auth-client';
import { getEnvironmentConfig } from '../config/environments';

const PLAN_KEY = 'nestjs_e2e_quota';
const TICKET_LIMIT = 2;

describe('Plan limits as decorators (E2E, TBP-704)', () => {
  const config = getEnvironmentConfig();
  const api = config.testDataApiUrl;
  const testHeaders = {
    'Content-Type': 'application/json',
    'x-playwright-api-key': config.testDataApiKey,
  };

  let app: INestApplication;
  let request: supertest.Agent;
  let testDataClient: TestDataClient;
  let authClient: AuthClient;
  let account: PlaywrightTestAccount;

  async function testApi<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${api}/account/test/playwright/${path}`, {
      method: 'POST',
      headers: testHeaders,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /*
   * A usage change re-evaluates the workspace's entitlements and asks every
   * signed-in member to refresh their token; a browser SDK does that on its
   * own. This suite stands in for it by signing in afresh for each request.
   */
  async function token(): Promise<string> {
    return (await authClient.getToken(account.email, account.password)).accessToken;
  }

  /** Bridge's own view of the quota — what the plugin actually wrote. */
  async function bridgeQuota(metric: string): Promise<{ used: number; limit: number; kind?: string }> {
    const res = await fetch(`${api}/usage/quota/${metric}`, {
      headers: { Authorization: `Bearer ${await token()}`, 'x-app-id': config.appId },
    });
    if (!res.ok) throw new Error(`GET /usage/quota/${metric} answered ${res.status}`);
    return res.json();
  }

  /** Poll Bridge until `used` settles on the expected value (rollups are near-instant). */
  async function expectUsed(metric: string, expected: number): Promise<void> {
    let used = NaN;
    for (let i = 0; i < 20; i++) {
      used = (await bridgeQuota(metric)).used;
      if (used === expected) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(used).toBe(expected);
  }

  beforeAll(async () => {
    testDataClient = new TestDataClient(config);
    authClient = new AuthClient(config.authBaseUrl, config.appId);

    // The plan and its quotas.
    await testApi('ensure-plan', {
      appDomain: config.appDomain,
      key: PLAN_KEY,
      name: 'NestJS quota E2E',
      prices: [{ amount: 10, currency: 'USD', recurrenceInterval: 'month' }],
    });
    const { token: apiToken } = await testApi<{ token: string }>('generate-jwt', {
      appDomain: config.appDomain,
      privileges: ['AUTHENTICATED', 'USER_READ', 'USER_WRITE', 'TENANT_READ', 'TENANT_WRITE'],
    });
    const put = await fetch(`${api}/v1/account/payments/plan/${PLAN_KEY}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiToken },
      body: JSON.stringify({
        quotas: [
          { metric: 'tickets', limit: TICKET_LIMIT, policy: 'hard', kind: 'gauge' },
          { metric: 'exports', limit: 50, policy: 'hard', kind: 'counter' },
        ],
      }),
    });
    if (!put.ok) throw new Error(`setting plan quotas answered ${put.status}: ${await put.text()}`);

    // A fresh workspace on that plan.
    account = await testDataClient.createTestAccount();
    await testApi('set-tenant-plan', {
      appDomain: config.appDomain,
      tenantId: account.tenantId,
      planKey: PLAN_KEY,
      currency: 'USD',
      recurrenceInterval: 'month',
    });

    app = await createTestApp();
    request = supertest(app.getHttpServer());
  });

  afterAll(async () => {
    await app?.close();
    if (account) await testDataClient.removeTestAccount(account.email).catch(() => {});
  });

  describe('gauge — tickets', () => {
    const created: string[] = [];

    it('creates up to the limit, and Bridge holds the app\'s count', async () => {
      for (let i = 0; i < TICKET_LIMIT; i++) {
        const res = await request
          .post('/tickets')
          .set('Authorization', `Bearer ${await token()}`)
          .send({ title: `ticket ${i}` });
        expect(res.status).toBe(201);
        created.push(res.body.id);
      }
      await expectUsed('tickets', TICKET_LIMIT);
      expect((await bridgeQuota('tickets')).kind).toBe('gauge');
    });

    it('a create at the cap is refused 402 with the metric, the numbers and where to upgrade', async () => {
      const res = await request
        .post('/tickets')
        .set('Authorization', `Bearer ${await token()}`)
        .send({ title: 'one too many' });

      expect(res.status).toBe(402);
      expect(res.body).toEqual({
        statusCode: 402,
        code: 'QUOTA_EXCEEDED',
        message: expect.any(String),
        metric: 'tickets',
        used: TICKET_LIMIT,
        limit: TICKET_LIMIT,
        fix: '/subscription',
      });
      // Nothing was created and nothing was recorded.
      const list = await request.get('/tickets').set('Authorization', `Bearer ${await token()}`);
      expect(list.body).toHaveLength(TICKET_LIMIT);
      await expectUsed('tickets', TICKET_LIMIT);
    });

    it('a delete lowers the gauge in Bridge, and the room comes back', async () => {
      const del = await request
        .delete(`/tickets/${created.pop()}`)
        .set('Authorization', `Bearer ${await token()}`);
      expect(del.status).toBe(200);
      await expectUsed('tickets', TICKET_LIMIT - 1);

      const again = await request
        .post('/tickets')
        .set('Authorization', `Bearer ${await token()}`)
        .send({ title: 'room again' });
      expect(again.status).toBe(201);
      await expectUsed('tickets', TICKET_LIMIT);
    });

    it('a delete that fails (404) leaves the gauge alone', async () => {
      const del = await request.delete('/tickets/nope').set('Authorization', `Bearer ${await token()}`);
      expect(del.status).toBe(404);
      await expectUsed('tickets', TICKET_LIMIT);
    });
  });

  describe('counter — exports', () => {
    let ticketId: string;

    beforeAll(async () => {
      const list = await request.get('/tickets').set('Authorization', `Bearer ${await token()}`);
      ticketId = list.body[0].id;
    });

    it('two exports with the same Idempotency-Key are one usage event', async () => {
      const before = (await bridgeQuota('exports')).used;
      const key = `export-${Date.now()}`;

      for (let i = 0; i < 2; i++) {
        const res = await request
          .post(`/tickets/${ticketId}/export`)
          .set('Authorization', `Bearer ${await token()}`)
          .set('Idempotency-Key', key);
        expect(res.status).toBe(201);
      }
      await expectUsed('exports', before + 1);

      // A different key is a different export.
      const third = await request
        .post(`/tickets/${ticketId}/export`)
        .set('Authorization', `Bearer ${await token()}`)
        .set('Idempotency-Key', `${key}-b`);
      expect(third.status).toBe(201);
      await expectUsed('exports', before + 2);
    });

    it('an export that fails (404) records nothing', async () => {
      const before = (await bridgeQuota('exports')).used;
      const res = await request.post('/tickets/nope/export').set('Authorization', `Bearer ${await token()}`);
      expect(res.status).toBe(404);
      // Give a (wrongly) recorded event time to land before asserting it did not.
      await new Promise((r) => setTimeout(r, 1000));
      expect((await bridgeQuota('exports')).used).toBe(before);
    });
  });

  it('an unauthenticated caller is refused before any quota logic', async () => {
    const res = await request.post('/tickets').send({ title: 'x' });
    expect(res.status).toBe(401);
  });
});
