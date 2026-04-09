/**
 * E2E: Role-Based Access Control
 *
 * Tests that the ADMIN role guard enforces access correctly:
 *   - A regular USER cannot access /admin/* routes → 403
 *   - An ADMIN user can access /admin/* routes → 200
 *
 * The demo AppModule configures:
 *   { path: '/admin/*', role: 'ADMIN' }
 *
 * Test accounts created by TestDataClient are typically assigned the OWNER role
 * for the first user (app owner) and USER role for subsequent accounts.
 * We test the 403 case with the non-owner account.
 */

import { INestApplication } from '@nestjs/common';
import supertest from 'supertest';
import { createTestApp } from './_helpers/app-factory';
import { TestDataClient, PlaywrightTestAccount } from '../utils/test-data-client';
import { AuthClient } from '../utils/auth-client';
import { getEnvironmentConfig } from '../config/environments';

describe('RBAC — /admin/* routes (E2E)', () => {
  let app: INestApplication;
  let request: supertest.Agent;
  let testDataClient: TestDataClient;
  let authClient: AuthClient;
  let userAccount: PlaywrightTestAccount;
  let userToken: string;

  beforeAll(async () => {
    const config = getEnvironmentConfig();
    testDataClient = new TestDataClient(config);
    authClient = new AuthClient(config.authBaseUrl, config.appId);

    // Create a regular test user (non-owner)
    userAccount = await testDataClient.createTestAccount();
    userToken = (
      await authClient.getToken(userAccount.email, userAccount.password)
    ).accessToken;

    app = await createTestApp();
    request = supertest(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
    await testDataClient.removeTestAccount(userAccount.email).catch(() => {});
  });

  it('returns 401 for unauthenticated requests to /admin/users', async () => {
    const res = await request.get('/admin/users');
    expect(res.status).toBe(401);
  });

  it('returns 403 when a non-admin user accesses /admin/users', async () => {
    const res = await request
      .get('/admin/users')
      .set('Authorization', `Bearer ${userToken}`);
    // USER role cannot access ADMIN routes
    expect(res.status).toBe(403);
  });

  it('returns 403 when a non-admin user accesses /admin/dashboard', async () => {
    const res = await request
      .get('/admin/dashboard')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });
});

describe('RBAC — /admin/settings requires OWNER role (E2E)', () => {
  let app: INestApplication;
  let request: supertest.Agent;
  let testDataClient: TestDataClient;
  let authClient: AuthClient;
  let userAccount: PlaywrightTestAccount;
  let userToken: string;

  beforeAll(async () => {
    const config = getEnvironmentConfig();
    testDataClient = new TestDataClient(config);
    authClient = new AuthClient(config.authBaseUrl, config.appId);

    userAccount = await testDataClient.createTestAccount();
    userToken = (
      await authClient.getToken(userAccount.email, userAccount.password)
    ).accessToken;

    app = await createTestApp();
    request = supertest(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
    await testDataClient.removeTestAccount(userAccount.email).catch(() => {});
  });

  it('returns 403 when a non-owner user accesses /admin/settings', async () => {
    const res = await request
      .get('/admin/settings')
      .set('Authorization', `Bearer ${userToken}`);
    // The @RequireRole('OWNER') decorator on the settings endpoint
    // requires OWNER, which a regular test user does not have.
    expect(res.status).toBe(403);
  });
});
