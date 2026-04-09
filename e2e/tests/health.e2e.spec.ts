/**
 * E2E: Public health check endpoint
 *
 * Verifies that GET /health returns 200 without any authentication.
 */

import { INestApplication } from '@nestjs/common';
import supertest from 'supertest';
import { createTestApp } from './_helpers/app-factory';

describe('GET /health (public)', () => {
  let app: INestApplication;
  let request: supertest.Agent;

  beforeAll(async () => {
    app = await createTestApp();
    request = supertest(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 without a token', async () => {
    const res = await request.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('returns 200 even with an invalid token', async () => {
    const res = await request
      .get('/health')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(200);
  });
});
