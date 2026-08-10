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
  // BRIDGE_APP_ID / BRIDGE_API_BASE_URL are set by e2e/load-test-env.ts
  // (Jest setupFiles), NOT here. demo/src/app.module.ts reads them inside its
  // @Module decorator, which is evaluated by the top-level import above —
  // before this function ever runs. Assigning them here would be too late and
  // would silently leave the demo app on 'demo-app-id' +
  // https://api.thebridge.dev. Fail loudly instead of pointing at production.
  if (!process.env.BRIDGE_APP_ID || !process.env.BRIDGE_API_BASE_URL) {
    throw new Error(
      'BRIDGE_APP_ID / BRIDGE_API_BASE_URL are not set. e2e/load-test-env.ts ' +
        'must run as a Jest setupFile before demo/src/app.module.ts is imported. ' +
        'Refusing to run against the production default apiBaseUrl.',
    );
  }

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  await app.init();
  return app;
}
