/**
 * Creates and caches an in-process NestJS application for E2E testing.
 *
 * Uses @nestjs/testing to spin up the demo AppModule in-process, so tests make
 * real HTTP calls (via supertest) without starting a separate server process.
 *
 * The NestJS app is cached for the lifetime of a test suite — create it in
 * beforeAll() and close it in afterAll().
 *
 * IMPORTANT: process.env.BRIDGE_APP_ID must be set before calling createTestApp().
 * This is handled by e2e/load-test-env.ts via Jest setupFiles.
 *
 * @example
 * ```typescript
 * import { createTestApp } from './_helpers/app-factory';
 * import * as supertest from 'supertest';
 *
 * let req: supertest.Agent;
 *
 * beforeAll(async () => {
 *   const app = await createTestApp();
 *   req = supertest(app.getHttpServer());
 * });
 *
 * afterAll(async () => {
 *   await app.close();
 * });
 * ```
 */

import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../../demo/src/app.module';

/**
 * Create a fresh NestJS test application from the demo AppModule.
 *
 * Each call creates a new application instance — close it in afterAll()
 * to free ports and connections.
 */
export async function createTestApp(): Promise<INestApplication> {
  // BRIDGE_APP_ID must match the test app created by pre-setup.ts.
  // Jest's setupFiles (load-test-env.ts) loads it from .env.test.local.
  process.env.BRIDGE_APP_ID = process.env.BRIDGE_TEST_APP_ID;

  // Use local auth base URL if provided (for tests against local bridge-api)
  if (process.env.LOCAL_AUTH_BASE_URL) {
    process.env.BRIDGE_AUTH_BASE_URL = process.env.LOCAL_AUTH_BASE_URL.replace(
      /\/auth$/,
      '',
    );
  }
  if (process.env.LOCAL_TEST_DATA_API_URL) {
    process.env.BRIDGE_BACKENDLESS_BASE_URL =
      process.env.LOCAL_TEST_DATA_API_URL;
  }

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  await app.init();
  return app;
}
