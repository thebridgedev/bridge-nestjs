/**
 * Loads e2e/config/.env.test.local into process.env before Jest runs any tests.
 *
 * Listed in jest.e2e.config.js → setupFiles (runs in the test process,
 * before any describe/it blocks, before globalSetup).
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

const envFilePath = path.join(__dirname, 'config', '.env.test.local');
dotenv.config({ path: envFilePath });

// ---------------------------------------------------------------------------
// Map the E2E-only vars onto the names demo/src/app.module.ts reads.
//
// This MUST happen here and not in createTestApp(): `@Module({ imports: [
// BridgeModule.forRoot({ appId: process.env.BRIDGE_APP_ID, apiBaseUrl:
// process.env.BRIDGE_API_BASE_URL, … }) ] })` is evaluated when app.module.ts
// is *imported*, and app-factory.ts imports it at the top of the file — long
// before any beforeAll() runs. Assigning inside createTestApp() is therefore
// always too late: the module had already captured `undefined`, leaving appId
// as the literal 'demo-app-id' and apiBaseUrl on its production default
// (https://api.thebridge.dev). Every user token then failed verification
// against production's JWKS and the suites saw 401s.
//
// setupFiles run before the test file (and its imports) are loaded, so the
// values are in place by the time the decorator is evaluated.
// ---------------------------------------------------------------------------
if (process.env.BRIDGE_TEST_APP_ID) {
  process.env.BRIDGE_APP_ID = process.env.BRIDGE_TEST_APP_ID;
}

// Mirrors the resolution order in e2e/config/environments.ts, including its
// http://localhost:3200 default, so the demo app and the specs that build their
// own BridgeModule always agree on the API base.
const apiBaseUrlByEnv: Record<string, string | undefined> = {
  local: process.env.LOCAL_TEST_DATA_API_URL || 'http://localhost:3200',
  stage: process.env.STAGE_TEST_DATA_API_URL,
  prod: process.env.PROD_TEST_DATA_API_URL,
};
const e2eEnv = process.env.E2E_ENV || 'local';
const apiBaseUrl = apiBaseUrlByEnv[e2eEnv] ?? apiBaseUrlByEnv.local;
if (apiBaseUrl) {
  process.env.BRIDGE_API_BASE_URL = apiBaseUrl;
}
