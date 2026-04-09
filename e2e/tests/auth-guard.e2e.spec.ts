/**
 * E2E: BridgeAuthGuard — token verification and request context
 *
 * Tests the global auth guard behaviour:
 *   - Missing token → 401 with WWW-Authenticate
 *   - Invalid token  → 401 with WWW-Authenticate
 *   - Valid token    → 200 with user context attached
 */

import { INestApplication } from '@nestjs/common';
import supertest from 'supertest';
import { createTestApp } from './_helpers/app-factory';
import { TestDataClient, PlaywrightTestAccount } from '../utils/test-data-client';
import { AuthClient } from '../utils/auth-client';
import { getEnvironmentConfig } from '../config/environments';

describe('BridgeAuthGuard (E2E)', () => {
  let app: INestApplication;
  let request: supertest.Agent;
  let testDataClient: TestDataClient;
  let authClient: AuthClient;
  let account: PlaywrightTestAccount;
  let accessToken: string;

  beforeAll(async () => {
    const config = getEnvironmentConfig();
    testDataClient = new TestDataClient(config);
    authClient = new AuthClient(config.authBaseUrl, config.appId);

    // Create a fresh test user for this suite
    account = await testDataClient.createTestAccount();
    accessToken = (await authClient.getToken(account.email, account.password))
      .accessToken;

    app = await createTestApp();
    request = supertest(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
    await testDataClient.removeTestAccount(account.email).catch(() => {});
  });

  describe('missing token', () => {
    it('returns 401 with RFC 6750 WWW-Authenticate header', async () => {
      const res = await request.get('/items');
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/Bearer/);
      expect(res.headers['www-authenticate']).toMatch(/missing_token/);
    });
  });

  describe('invalid token', () => {
    it('returns 401 for a malformed token', async () => {
      const res = await request
        .get('/items')
        .set('Authorization', 'Bearer not.a.real.jwt');
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/invalid_token/);
    });
  });

  describe('valid token', () => {
    it('returns 200 and exposes user context in the response', async () => {
      const res = await request
        .get('/items')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe(account.email);
    });

    it('exposes tenant context in the response', async () => {
      const res = await request
        .get('/items')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.tenant).toBeDefined();
      expect(res.body.tenant.id).toBe(account.tenantId);
    });
  });
});
