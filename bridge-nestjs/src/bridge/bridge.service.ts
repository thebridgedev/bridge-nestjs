// TBP-341 — BridgeService: unified backend surface for NestJS.
//
// Server-side counterpart of the bridge-svelte `bridge` object. The two big
// differences vs the frontend surface:
//
//   1. NO channel. Pull mode: each `.snapshot()` call fetches via REST and
//      is cached via BridgePullCache (TTL configurable; defaults to 30s).
//      Live updates aren't a thing on the server — use Bridge webhooks for
//      event-driven server reactions (out of scope for this milestone).
//
//   2. NO singleton tenant. Every request has a different tenant context;
//      the SDK takes the request's VERIFIED user token and returns a
//      TenantScope whose slices answer for THAT user's tenant.
//
// Typical usage from a NestJS handler behind BridgeAuthGuard:
//
//   constructor(private readonly bridge: BridgeService) {}
//
//   @UseGuards(BridgeAuthGuard)
//   async handler(@Req() req: Request) {
//     const tenant = this.bridge.fromRequest(req);
//     if (!(await tenant.entitlements.can('export'))) {
//       throw new ForbiddenException();
//     }
//     return tenant.subscription;
//   }
//
// `bridge.tenant(tenantId)` for arbitrary tenants (cron/admin paths) is not
// yet wired — bridge-api doesn't expose a tenant-by-id snapshot endpoint that
// accepts the workspace API key. Tracked as a follow-up; calling it throws
// a clear `Error` with the migration pointer.

import { createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { BridgePullCache } from '@nebulr-group/bridge-auth-core';

import { BRIDGE_PULL_CACHE } from '../flags/flags.tokens';
import { JwksService } from '../services/jwks.service';
import type { JwtClaims } from '../types/user';
import { BRIDGE_OPTIONS, type BridgeModuleOptions } from './bridge.tokens';
import { TenantScope } from './tenant-scope';
import { verifiedUserTokenFor } from './verified-request';

/** The snapshot cache key, from VERIFIED claims only: `tid:sub`. */
function cacheKeyFor(claims: JwtClaims): string {
  const tid = claims.tid ?? claims.tenant_id;
  return tid ? `${tid}:${claims.sub ?? ''}` : claims.sub;
}

@Injectable()
export class BridgeService {
  /** Per `tid:sub`: the newest token seen (a hash of it, never the token). */
  private readonly newestToken = new Map<string, { iat?: number; fingerprint: string }>();

  constructor(
    @Inject(BRIDGE_OPTIONS) private readonly opts: BridgeModuleOptions,
    @Inject(BRIDGE_PULL_CACHE) private readonly cache: BridgePullCache,
    private readonly jwks: JwksService,
  ) {}

  /**
   * Return a TenantScope for the tenant associated with `userJwt` (the raw
   * token, without the `Bearer ` prefix).
   *
   * The token is verified first, the same way `BridgeAuthGuard` verifies it
   * (signature against the Bridge JWKS, issuer, audience = your app id,
   * expiry). Verification is lazy so this call stays synchronous: every read
   * on the returned scope awaits it, and an unverifiable token rejects each
   * read with a `TokenVerificationError` — no cached snapshot is read,
   * written or evicted for it (TBP-673). Behind `BridgeAuthGuard`, prefer
   * {@link fromRequest}, which reuses the guard's verification.
   *
   * Caching is keyed on the verified `tid:sub`, so concurrent requests for
   * the same user share one round-trip; a newer token for that user starts a
   * fresh snapshot (see noteToken).
   */
  fromJwt(userJwt: string): TenantScope {
    const cacheKey = this.jwks
      .verifyToken(userJwt)
      .then((claims) => this.admit(userJwt, claims));
    return this.scope(userJwt, cacheKey);
  }

  /**
   * Return a TenantScope for the user `BridgeAuthGuard` authenticated on this
   * request, reusing the token and claims the guard already verified.
   *
   * Throws when the guard did not verify a user token on this request — an
   * unguarded route, a `@Public()` route, or an API-token-only caller.
   * Headers and request properties are never read in its place.
   */
  fromRequest(req: unknown): TenantScope {
    const verified = verifiedUserTokenFor(req);
    if (!verified) {
      throw new Error(
        '[bridge-nestjs] `bridge.fromRequest(req)` needs a request whose user token BridgeAuthGuard verified. Put the route behind `@UseGuards(BridgeAuthGuard)` (or the global guard), or call `bridge.fromJwt(token)`, which verifies the token itself.',
      );
    }
    return this.scope(verified.token, Promise.resolve(this.admit(verified.token, verified.claims)));
  }

  private scope(userJwt: string, cacheKey: Promise<string>): TenantScope {
    return new TenantScope(userJwt, cacheKey, this.cache, this.opts.apiBaseUrl, this.opts.appId);
  }

  /** Runs only for a verified token: derive the key, then note the token. */
  private admit(jwt: string, claims: JwtClaims): string {
    const cacheKey = cacheKeyFor(claims);
    this.noteToken(cacheKey, jwt, claims.iat);
    return cacheKey;
  }

  /*
   * TBP-644 — a NEWER token for the same user drops that user's cached
   * snapshot.
   *
   * The snapshot answers plan and entitlement gates (`plans:` /
   * `entitlement:` route rules). Keyed on `tid:sub` alone, a user who upgraded
   * kept getting 402 for the full TTL even with a token issued after the
   * upgrade — measured on stage: 30.3 s, while /session/init already said
   * `pro` after 0.2 s. Bridge re-issues a user's token precisely when their
   * plan, role or entitlements change (the frontend SDKs refresh on
   * `user.state_changed` within a second), so a newer token is the signal
   * that the cached snapshot may be out of date.
   *
   * The key stays `tid:sub` — keying on the token would grow the cache by one
   * entry per token for the life of the process. An OLDER token than the
   * newest seen does not invalidate: it keeps reading the snapshot fetched
   * for the newer one, which is the fresher of the two. A client that never
   * gets a new token still sees the change within the TTL.
   *
   * TBP-673 — only ever called with a verified token and its verified `iat`,
   * so a forged token can neither evict nor pin another user's snapshot.
   */
  private noteToken(cacheKey: string, jwt: string, iat: number | undefined): void {
    const fingerprint = createHash('sha256').update(jwt).digest('hex');
    const seen = this.newestToken.get(cacheKey);
    if (seen?.fingerprint === fingerprint) return;
    if (seen && seen.iat !== undefined && iat !== undefined && iat < seen.iat) return;
    if (seen) this.cache.invalidate(`session:${cacheKey}`);
    this.newestToken.set(cacheKey, { iat, fingerprint });
  }

  /**
   * Reserved — arbitrary-tenant accessor for cron / admin paths. Not yet
   * wired: bridge-api doesn't expose a tenant-by-id snapshot endpoint that
   * accepts the workspace API key. Use `fromRequest(req)` (or
   * `fromJwt(userJwt)`) for the request-scoped path.
   */
  tenant(_tenantId: string): never {
    throw new Error(
      '[bridge-nestjs] `bridge.tenant(tenantId)` requires a bridge-api admin snapshot endpoint that accepts the workspace API key — not yet implemented. Use `bridge.fromRequest(req)` from your request handler instead.',
    );
  }
}
