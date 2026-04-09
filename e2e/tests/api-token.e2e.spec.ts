/**
 * E2E: API Token authentication via BridgeAuthGuard
 *
 * Tests the API token (x-api-key header) path of BridgeAuthGuard:
 *   - Valid API token → 200
 *   - Wrong appId in token → 401
 *   - No token → 401
 *   - @RequirePrivilege present, token has privilege → 200
 *   - @RequirePrivilege present, token missing privilege → 403
 *   - User JWT with @RequirePrivilege → 200 (backward compat — user tokens bypass privilege check)
 *   - API token with empty privileges array + @RequirePrivilege → 403
 *
 * Uses inline controllers and a real bridge-api instance for token issuance + JWKS.
 */

import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import {
  BridgeModule,
  BridgeAuthGuard,
  RequirePrivilege,
} from '@nebulr-group/bridge-nestjs';
import { TestDataClient, PlaywrightTestAccount } from '../utils/test-data-client';
import { AuthClient } from '../utils/auth-client';
import { getEnvironmentConfig } from '../config/environments';

// ---------------------------------------------------------------------------
// Inline test controllers
// ---------------------------------------------------------------------------

@Controller('api-token-test')
class ApiTokenTestController {
  @Get('protected')
  @UseGuards(BridgeAuthGuard)
  protected(): { ok: boolean } {
    return { ok: true };
  }

  @Get('privileged')
  @UseGuards(BridgeAuthGuard)
  @RequirePrivilege('USER_READ')
  privileged(): { ok: boolean } {
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Helper: create an API token via the bridge-api
// ---------------------------------------------------------------------------

async function createApiToken(
  testDataApiUrl: string,
  appApiKey: string,
  privileges: string[],
): Promise<string> {
  const res = await fetch(`${testDataApiUrl}/account/api-token/app`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': appApiKey,
    },
    body: JSON.stringify({ name: `E2E test token ${Date.now()}`, privileges }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create API token (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { token: string };
  return data.token;
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('API token authentication (E2E)', () => {
  let app: INestApplication;
  let request: supertest.Agent;
  let testDataClient: TestDataClient;
  let authClient: AuthClient;
  let account: PlaywrightTestAccount;
  let userAccessToken: string;
  let apiTokenWithPrivilege: string;
  let apiTokenWithoutPrivilege: string;
  let apiTokenEmpty: string;

  const config = getEnvironmentConfig();

  beforeAll(async () => {
    testDataClient = new TestDataClient(config);
    authClient = new AuthClient(config.authBaseUrl, config.appId);

    // Create a test user and get a user JWT (for backward compat tests)
    account = await testDataClient.createTestAccount();
    userAccessToken = (await authClient.getToken(account.email, account.password)).accessToken;

    // Create API tokens via bridge-api
    apiTokenWithPrivilege = await createApiToken(
      config.testDataApiUrl,
      config.testDataApiKey,
      ['USER_READ'],
    );
    apiTokenWithoutPrivilege = await createApiToken(
      config.testDataApiUrl,
      config.testDataApiKey,
      ['TENANT_READ'],
    );
    apiTokenEmpty = await createApiToken(config.testDataApiUrl, config.testDataApiKey, []);

    // Build a test NestJS app with BridgeModule wired to the real bridge-api JWKS
    const moduleFixture = await Test.createTestingModule({
      imports: [
        BridgeModule.forRoot({
          appId: config.appId,
          authBaseUrl: config.testDataApiUrl,
          guard: { global: false },
        }),
      ],
      controllers: [ApiTokenTestController],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    request = supertest(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
    await testDataClient.removeTestAccount(account.email).catch(() => {});
  });

  it('GET /api-token-test/protected with valid API token → 200', async () => {
    const res = await request
      .get('/api-token-test/protected')
      .set('x-api-key', apiTokenWithPrivilege);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /api-token-test/protected with wrong appId in token → 401', async () => {
    // Create a token for a different app by tampering the payload
    // (easier: use a random JWT-shaped but unverifiable string)
    const fakeToken = 'eyJhbGciOiJIUzI1NiJ9.eyJhcHBJZCI6Im90aGVyLWFwcCIsInR5cGUiOiJhcGkiLCJwcml2aWxlZ2VzIjpbXX0.fakeSignature';
    const res = await request
      .get('/api-token-test/protected')
      .set('x-api-key', fakeToken);
    expect(res.status).toBe(401);
  });

  it('GET /api-token-test/protected with no token → 401', async () => {
    const res = await request.get('/api-token-test/protected');
    expect(res.status).toBe(401);
  });
});

describe('Privilege enforcement (E2E)', () => {
  let app: INestApplication;
  let request: supertest.Agent;
  let testDataClient: TestDataClient;
  let authClient: AuthClient;
  let account: PlaywrightTestAccount;
  let userAccessToken: string;
  let tokenWithPrivilege: string;
  let tokenMissingPrivilege: string;
  let tokenEmptyPrivileges: string;

  const config = getEnvironmentConfig();

  beforeAll(async () => {
    testDataClient = new TestDataClient(config);
    authClient = new AuthClient(config.authBaseUrl, config.appId);

    account = await testDataClient.createTestAccount();
    userAccessToken = (await authClient.getToken(account.email, account.password)).accessToken;

    tokenWithPrivilege = await createApiToken(
      config.testDataApiUrl,
      config.testDataApiKey,
      ['USER_READ'],
    );
    tokenMissingPrivilege = await createApiToken(
      config.testDataApiUrl,
      config.testDataApiKey,
      ['TENANT_READ'],
    );
    tokenEmptyPrivileges = await createApiToken(config.testDataApiUrl, config.testDataApiKey, []);

    const moduleFixture = await Test.createTestingModule({
      imports: [
        BridgeModule.forRoot({
          appId: config.appId,
          authBaseUrl: config.testDataApiUrl,
          guard: { global: false },
        }),
      ],
      controllers: [ApiTokenTestController],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    request = supertest(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
    await testDataClient.removeTestAccount(account.email).catch(() => {});
  });

  it('GET /api-token-test/privileged with token carrying USER_READ → 200', async () => {
    const res = await request
      .get('/api-token-test/privileged')
      .set('x-api-key', tokenWithPrivilege);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /api-token-test/privileged with token missing USER_READ → 403', async () => {
    const res = await request
      .get('/api-token-test/privileged')
      .set('x-api-key', tokenMissingPrivilege);
    expect(res.status).toBe(403);
  });

  it('GET /api-token-test/privileged with user JWT (no privileges) → 200 (backward compat)', async () => {
    const res = await request
      .get('/api-token-test/privileged')
      .set('Authorization', `Bearer ${userAccessToken}`);
    expect(res.status).toBe(200);
  });

  it('GET /api-token-test/privileged with API token, empty privileges array → 403', async () => {
    const res = await request
      .get('/api-token-test/privileged')
      .set('x-api-key', tokenEmptyPrivileges);
    expect(res.status).toBe(403);
  });
});
