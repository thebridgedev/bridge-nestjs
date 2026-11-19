import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BridgeService } from '../src';
import { createSignedIssuer, type SignedIssuer } from './support/signed-issuer';
import { startApp } from './support/test-app';

/**
 * A route nobody signed in to (`@Public()`) still reads flags: Bridge answers as it does for any visitor, with the
 * flags marked public only, and no credential of the app is sent for a stranger.
 */
describe('flags on a public route, for a caller who is not signed in', () => {
  let issuer: SignedIssuer;
  let app: INestApplication;

  beforeEach(async () => {
    issuer = await createSignedIssuer();
    // The app's rule on `internal-tools` is not public, so Bridge leaves it out of a visitor's results.
    issuer.setVisitorFlags([{ key: 'banner', value: true }, { key: 'page-size', value: 50 }]);
    app = await startApp(issuer);
  });

  afterEach(async () => {
    await app.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);

  it('lets a visitor through a gate whose flag is public and on', async () => {
    const answer = await get('/public/banner');
    expect(answer.status).toBe(200);
    expect(issuer.visitorAsks).toHaveLength(1);
  });

  it('refuses a visitor on a gate whose flag Bridge does not show them (not public, or off), with 403 FEATURE_OFF', async () => {
    issuer.setVisitorFlags([]);
    const answer = await get('/public/banner');
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ code: 'FEATURE_OFF', flag: 'banner' });
  });

  it('gives @Flag, @Flags and the service the visitor\'s results, and every other flag its fallback', async () => {
    const answer = await get('/public/flags');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ banner: true, size: 50, internal: false, viaService: true });
    // One question to Bridge for the request, however many reads.
    expect(issuer.visitorAsks).toHaveLength(1);
  });

  it('asks as a visitor: no key, no token, and nothing the visitor sent', async () => {
    await get('/public/banner').set('x-tenant-id', 'someone-else').set('x-bridge-context', '{"user":{"id":"u1"}}');
    const asked = issuer.visitorAsks[0];
    expect(asked?.headers['x-api-key']).toBeUndefined();
    expect(asked?.headers['authorization']).toBeUndefined();
    expect(asked?.body).toEqual({ context: {} });
  });

  it('treats a credential that does not check out as no caller at all', async () => {
    const answer = await get('/public/banner').set('authorization', 'Bearer not-a-token');
    expect(answer.status).toBe(200);
    expect(issuer.visitorAsks).toHaveLength(1);
    // The refused token was never sent to Bridge as a flag credential.
    expect(issuer.calls.filter((call) => call.headers['authorization'] === 'Bearer not-a-token')).toEqual([]);
  });

  it('keeps asking for a signed-in person as before: their own results, not a visitor\'s', async () => {
    issuer.setFlags('user-alice', [{ key: 'banner', value: false }, { key: 'page-size', value: 5 }]);
    const token = await issuer.personToken();
    const answer = await get('/public/flags').set('authorization', `Bearer ${token}`);
    expect(answer.body).toMatchObject({ banner: false, size: 5 });
    expect(issuer.visitorAsks).toHaveLength(0);
  });

  it('the service gives the visitor\'s flags for code with no request, with hints the server passes on', async () => {
    const flags = await app.get(BridgeService).visitorFlags({ country: 'SE' });
    expect(flags.enabled('banner')).toBe(true);
    expect(issuer.visitorAsks.at(-1)?.body).toEqual({ context: { country: 'SE' } });
  });

  it('gives every flag its fallback, and still serves the route, while Bridge cannot answer', async () => {
    issuer.setVisitorFlags([{ key: 'banner', value: true }]);
    // A failing fetch is the realistic outage.
    const failing = await startApp(issuer, { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).includes('/flags/apps/')) throw new TypeError('fetch failed');
      return issuer.fetch(input, init);
    }) as typeof fetch });
    const answer = await request(failing.getHttpServer()).get('/public/flags');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ banner: false, size: 20, internal: false, viaService: false });
    await failing.close();
  });
});
