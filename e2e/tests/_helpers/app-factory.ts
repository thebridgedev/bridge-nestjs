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
  // NOTE: BRIDGE_APP_ID / BRIDGE_API_BASE_URL are set in e2e/load-test-env.ts
  // (Jest setupFiles), which runs BEFORE app.module.ts is imported. They must
  // NOT be set here — the demo's BridgeModule.forRoot() reads them at import
  // time, which is already past by the time this function runs.
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  await app.init();
  return app;
}
