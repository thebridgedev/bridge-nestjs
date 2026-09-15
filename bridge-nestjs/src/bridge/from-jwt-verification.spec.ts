// TBP-673 — `bridge.fromJwt(token)` must verify the token before any claim
// in it is used, and a token it can't verify must never read, populate or
// evict a cached snapshot.
//
// Before the fix the cache key came from the UNVERIFIED token's `tid:sub`, so
// a forged token carrying a victim's tenant and user id was served the
// victim's cached subscription, entitlements and email; a forged token with a
// newer `iat` evicted the victim's snapshot.
//
// Nothing about verification is mocked here: the real NestJS JwksService
// wraps the real auth-core verifier and jose. Only the network is stubbed —
// global `fetch` serves a JWKS for a locally generated signing key, plus the
// bridge-api endpoints.

import 'reflect-metadata';

import { constants, generateKeyPairSync, sign, type KeyObject } from 'crypto';
import { BridgePullCache } from '@nebulr-group/bridge-auth-core';

import { BridgeService } from './bridge.service';
import type { SessionSnapshotData } from './tenant-scope';
import { rememberVerifiedUserToken } from './verified-request';
import { JwksService, TokenVerificationError } from '../services/jwks.service';
import { BridgeConfigService } from '../services/bridge-config.service';
import type { BridgeConfig } from '../types/config';

const API = 'https://api.test.example';
const APP_ID = 'app-1';
const config = new BridgeConfigService({ appId: APP_ID, apiBaseUrl: API } as BridgeConfig);
const ISSUER = config.authBaseUrl;
const JWKS_URL = config.jwksUrl;

const bridgeKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attackerKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'bridge-signing-key';
const JWKS = {
  keys: [{ ...(bridgeKey.publicKey.export({ format: 'jwk' }) as object), kid: KID, alg: 'PS256', use: 'sig' }],
};

const VICTIM = 'victim-user';
const TENANT = 'victim-tenant';

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

function signJwt(
  claims: Record<string, unknown>,
  { key = bridgeKey.privateKey, alg = 'PS256' }: { key?: KeyObject; alg?: 'PS256' | 'none' } = {},
): string {
  const input = `${b64url({ alg, typ: 'JWT', kid: KID })}.${b64url(claims)}`;
  if (alg === 'none') return `${input}.`;
  const signature = sign('sha256', Buffer.from(input), {
    key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return `${input}.${signature.toString('base64url')}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

function claims(sub: string, iat: number, extra: Record<string, unknown> = {}) {
  return { sub, tid: TENANT, iat, exp: nowSec() + 3600, iss: ISSUER, aud: APP_ID, ...extra };
}

/** A token the Bridge really issued for `sub`. */
const issued = (sub: string, iat: number) => signJwt(claims(sub, iat));

const snapshotFor = (plan: string): SessionSnapshotData => ({
  app: { branding: { logo: 'logo.svg', name: 'Acme' } },
  tenant: {
    id: TENANT,
    name: 'Victim Inc',
    subscription: { plan: { slug: plan, name: plan }, status: 'active' },
    entitlements: { canExport: plan === 'enterprise' },
  },
  user: { id: VICTIM, email: 'victim@example.com', role: 'OWNER', tenantId: TENANT },
});

describe('BridgeService.fromJwt verifies before it trusts (TBP-673)', () => {
  let current: SessionSnapshotData;
  let sessionAuth: string[];
  let usageCalls: string[];
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    current = snapshotFor('enterprise');
    sessionAuth = [];
    usageCalls = [];
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === JWKS_URL) return json(JWKS);
      if (url === `${API}/session/init`) {
        sessionAuth.push(String((init?.headers as Record<string, string>)?.Authorization));
        return json(current);
      }
      if (url.startsWith(`${API}/usage/`)) {
        usageCalls.push(url);
        return json(null);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  });

  afterEach(() => fetchSpy.mockRestore());

  function build() {
    const cache = new BridgePullCache({ ttlMs: 30_000 });
    const jwks = new JwksService(config);
    const verify = jest.spyOn(jwks, 'verifyToken');
    const svc = new BridgeService({ apiBaseUrl: API, appId: APP_ID, ttlMs: 30_000 }, cache, jwks);
    const cacheGet = jest.spyOn(cache, 'get');
    const cacheInvalidate = jest.spyOn(cache, 'invalidate');
    return { svc, verify, cacheGet, cacheInvalidate };
  }

  const forgeries: Array<[string, () => string]> = [
    ["signed with an attacker's key, victim's tid/sub, small iat", () =>
      signJwt(claims(VICTIM, 1), { key: attackerKey.privateKey })],
    ["alg: none, victim's tid/sub, small iat", () => signJwt(claims(VICTIM, 1), { alg: 'none' })],
    ['correctly signed but for another app (aud)', () => signJwt(claims(VICTIM, 1, { aud: 'other-app' }))],
    ['correctly signed but expired', () => signJwt(claims(VICTIM, 1, { exp: nowSec() - 60 }))],
  ];

  describe("while the victim's snapshot is cached", () => {
    let t: ReturnType<typeof build>;
    // One token, reused: PS256 signatures are randomized, so signing again
    // would give the victim a DIFFERENT token, which TBP-644 rightly treats
    // as a newer one and refetches for.
    let victimToken: string;

    beforeEach(async () => {
      t = build();
      victimToken = issued(VICTIM, 200);
      await t.svc.fromJwt(victimToken).subscription; // victim primes the cache
      expect(sessionAuth).toHaveLength(1);
      t.cacheGet.mockClear();
      t.cacheInvalidate.mockClear();
    });

    it.each(forgeries)('%s: every read rejects, and the cache is neither read nor evicted', async (_label, forge) => {
      const scope = t.svc.fromJwt(forge());

      await expect(scope.subscription).rejects.toBeInstanceOf(TokenVerificationError);
      await expect(scope.entitlements.can('canExport')).rejects.toBeInstanceOf(TokenVerificationError);
      await expect(scope.user).rejects.toBeInstanceOf(TokenVerificationError);
      await expect(scope.snapshot()).rejects.toBeInstanceOf(TokenVerificationError);

      expect(t.cacheGet).not.toHaveBeenCalled();
      expect(t.cacheInvalidate).not.toHaveBeenCalled();
      expect(sessionAuth).toHaveLength(1); // no fetch went out for the forged token

      // The victim's own snapshot is still served, without a refetch.
      expect((await t.svc.fromJwt(victimToken).subscription).plan.slug).toBe('enterprise');
      expect(sessionAuth).toHaveLength(1);
    });

    it("a forged token with a NEWER iat cannot evict the victim's snapshot", async () => {
      const forged = signJwt(claims(VICTIM, nowSec() + 600), { key: attackerKey.privateKey });
      await expect(t.svc.fromJwt(forged).subscription).rejects.toBeInstanceOf(TokenVerificationError);
      await t.svc.fromJwt(forged).invalidate();

      expect(t.cacheInvalidate).not.toHaveBeenCalled();
      await t.svc.fromJwt(victimToken).subscription;
      expect(sessionAuth).toHaveLength(1);
    });
  });

  it('a forged token for an uncached user populates nothing and calls no API', async () => {
    const t = build();
    const scope = t.svc.fromJwt(signJwt(claims('someone-else', 1), { key: attackerKey.privateKey }));

    await expect(scope.subscription).rejects.toBeInstanceOf(TokenVerificationError);
    await expect(scope.usage.quota('seats')).rejects.toBeInstanceOf(TokenVerificationError);
    await expect(scope.usage.report('seats', 1)).resolves.toBeUndefined(); // best-effort: never throws…

    expect(usageCalls).toEqual([]); // …and never sends
    expect(sessionAuth).toEqual([]);
    expect(t.cacheGet).not.toHaveBeenCalled();
  });

  it('an unread scope for a forged token raises no unhandled rejection', async () => {
    const t = build();
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      t.svc.fromJwt(signJwt(claims(VICTIM, 1), { key: attackerKey.privateKey }));
      await t.verify.mock.results[0]?.value.catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(t.verify).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });

  describe('verified tokens', () => {
    it('a valid token reads its own snapshot and forwards itself to bridge-api', async () => {
      const t = build();
      const token = issued(VICTIM, 200);
      const scope = t.svc.fromJwt(token);
      expect((await scope.subscription).plan.slug).toBe('enterprise');
      expect(await scope.entitlements.can('canExport')).toBe(true);
      expect(sessionAuth).toEqual([`Bearer ${token}`]);
      expect(t.verify).toHaveBeenCalledWith(token);
    });

    it('TBP-644 still holds: a newer verified token refreshes, an older one does not', async () => {
      const t = build();
      current = snapshotFor('free');
      expect((await t.svc.fromJwt(issued(VICTIM, 100)).subscription).plan.slug).toBe('free');

      current = snapshotFor('enterprise'); // upgraded; Bridge re-issues the token
      expect((await t.svc.fromJwt(issued(VICTIM, 200)).subscription).plan.slug).toBe('enterprise');
      expect(sessionAuth).toHaveLength(2);

      expect((await t.svc.fromJwt(issued(VICTIM, 100)).subscription).plan.slug).toBe('enterprise');
      expect(sessionAuth).toHaveLength(2);
    });

    it('invalidate() on a verified scope still forces a refetch', async () => {
      const t = build();
      const scope = t.svc.fromJwt(issued(VICTIM, 200));
      await scope.subscription;
      void scope.invalidate(); // not awaited: the next read must still see it
      await scope.subscription;
      expect(sessionAuth).toHaveLength(2);
    });
  });

  describe('fromRequest(req)', () => {
    it('reuses the token BridgeAuthGuard verified, without verifying again', async () => {
      const t = build();
      const token = issued(VICTIM, 200);
      const req = {};
      rememberVerifiedUserToken(req, token, claims(VICTIM, 200) as never);

      expect((await t.svc.fromRequest(req).subscription).plan.slug).toBe('enterprise');
      expect(t.verify).not.toHaveBeenCalled();
      expect(sessionAuth).toEqual([`Bearer ${token}`]);
    });

    it('refuses a request the guard did not verify, whatever it carries', () => {
      const t = build();
      const forged = signJwt(claims(VICTIM, 1), { key: attackerKey.privateKey });
      const req = {
        headers: { authorization: `Bearer ${forged}` },
        bridgeAccessToken: forged,
        bridgeUser: { id: VICTIM, tenantId: TENANT },
      };
      expect(() => t.svc.fromRequest(req)).toThrow(/BridgeAuthGuard/);
      expect(t.cacheGet).not.toHaveBeenCalled();
      expect(sessionAuth).toEqual([]);
    });
  });
});
