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

// Map the test env into the vars the demo AppModule reads at IMPORT time.
// The demo's `BridgeModule.forRoot({ appId: process.env.BRIDGE_APP_ID,
// apiBaseUrl: process.env.BRIDGE_API_BASE_URL })` is evaluated when app.module.ts
// is first imported — which happens during a test file's import graph, AFTER this
// setupFile runs but BEFORE createTestApp() is called. So these must be set here,
// not inside createTestApp(), or the guard boots with production defaults.
process.env.BRIDGE_APP_ID = process.env.BRIDGE_TEST_APP_ID;
if (process.env.LOCAL_TEST_DATA_API_URL) {
  process.env.BRIDGE_API_BASE_URL = process.env.LOCAL_TEST_DATA_API_URL;
}
