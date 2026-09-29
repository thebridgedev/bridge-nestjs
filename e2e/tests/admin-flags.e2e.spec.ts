/**
 * E2E: the demo's /admin/* routes are gated by flags (TBP-705).
 *
 * Every gate in app code is a flag. The demo AdminController carries
 *   @RequireFeatureFlag('admin-area')        — controller level
 *   @RequireFeatureFlag('admin-settings')    — /admin/settings
 * and the flags' rules say why (a privilege, e.g. `privileges contains
 * "USER_WRITE"`). The code never reads the caller's role.
 *
 * What this suite pins against a real bridge-api:
 *   - no credential → 401;
 *   - a signed-in user the flag is not on for → 403 (the guard refuses with a
 *     FEATURE_* body naming the flag), whatever role the token carries.
 *
 * The flags are not seeded in the e2e app, so they are off for everyone here;
 * the "flag on → 200" path is covered by the guard's unit specs.
 */

import { INestApplication } from '@nestjs/common';
import supertest from 'supertest';
import { createTestApp } from './_helpers/app-factory';
import { TestDataClient, PlaywrightTestAccount } from '../utils/test-data-client';
import { AuthClient } from '../utils/auth-client';
import { getEnvironmentConfig } from '../config/environments';

describe('/admin/* is gated by flags, not roles (E2E, TBP-705)', () => {
  let app: INestApplication;
  let request: supertest.Agent;
  let testDataClient: TestDataClient;
  let authClient: AuthClient;
  let account: PlaywrightTestAccount;
  let token: string;

  beforeAll(async () => {
    const config = getEnvironmentConfig();
    testDataClient = new TestDataClient(config);
    authClient = new AuthClient(config.authBaseUrl, config.appId);

    // A fresh account owns its own workspace, so its token carries the OWNER
    // role. That must not open anything: only the flag decides.
    account = await testDataClient.createTestAccount();
    token = (await authClient.getToken(account.email, account.password)).accessToken;

    app = await createTestApp();
    request = supertest(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
    await testDataClient.removeTestAccount(account.email).catch(() => {});
  });

  it.each(['/admin/users', '/admin/dashboard', '/admin/settings'])(
    'returns 401 for unauthenticated requests to %s',
    async (path) => {
      const res = await request.get(path);
      expect(res.status).toBe(401);
    },
  );

  it.each([
    ['/admin/users', 'admin-area'],
    ['/admin/dashboard', 'admin-area'],
    ['/admin/settings', 'admin-settings'],
  ])('returns 403 on %s when the %s flag is off, even for the OWNER', async (path, flag) => {
    const res = await request.get(path).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain(flag);
  });
});
