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
