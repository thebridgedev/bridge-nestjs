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
//      the SDK takes the incoming user JWT and returns a TenantScope whose
//      slices answer for THAT user's tenant.
//
// Typical usage from a NestJS handler:
//
//   constructor(private readonly bridge: BridgeService) {}
//
//   async handler(@Headers('authorization') auth: string) {
//     const tenant = this.bridge.fromJwt(stripBearer(auth));
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
import { getTenantId, getTenantUserId } from '@nebulr-group/bridge-auth-core/backend';

import { BRIDGE_PULL_CACHE } from '../flags/flags.tokens';
import { BRIDGE_OPTIONS, type BridgeModuleOptions } from './bridge.tokens';
import { TenantScope } from './tenant-scope';

function decodeJwtSub(jwt: string): string {
  // Best-effort: build a stable cache key from the JWT's tenant/user claims.
  // We don't verify the signature here — that's the bridge-api's job at the
  // receiving end. The cache key only needs to be stable per JWT.
  const tid = getTenantId(jwt);
  const sub = getTenantUserId(jwt);
  if (tid) return `${tid}:${sub ?? ''}`;
  return sub ?? jwt;
}

function decodeIat(jwt: string): number | undefined {
  try {
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof claims?.iat === 'number' ? claims.iat : undefined;
  } catch {
    return undefined;
  }
}

@Injectable()
export class BridgeService {
  /** Per `tid:sub`: the newest token seen (a hash of it, never the token). */
  private readonly newestToken = new Map<string, { iat?: number; fingerprint: string }>();

  constructor(
    @Inject(BRIDGE_OPTIONS) private readonly opts: BridgeModuleOptions,
    @Inject(BRIDGE_PULL_CACHE) private readonly cache: BridgePullCache,
  ) {}

  /**
   * Return a TenantScope for the tenant associated with `userJwt`. The JWT
   * is forwarded to bridge-api on the snapshot fetch — the API derives the
   * tenant from the token (req.bridgeTenant) and returns the matching
   * snapshot. Caching is keyed on the JWT's `tid:sub` claim so two
   * concurrent requests for the same user share one round-trip; a newer
   * token for that user starts a fresh snapshot (see noteToken).
   */
  fromJwt(userJwt: string): TenantScope {
    const cacheKey = decodeJwtSub(userJwt);
    this.noteToken(cacheKey, userJwt);
    return new TenantScope(
      userJwt,
      cacheKey,
      this.cache,
      this.opts.apiBaseUrl,
      this.opts.appId,
    );
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
   */
  private noteToken(cacheKey: string, jwt: string): void {
    const fingerprint = createHash('sha256').update(jwt).digest('hex');
    const seen = this.newestToken.get(cacheKey);
    if (seen?.fingerprint === fingerprint) return;
    const iat = decodeIat(jwt);
    if (seen && seen.iat !== undefined && iat !== undefined && iat < seen.iat) return;
    if (seen) this.cache.invalidate(`session:${cacheKey}`);
    this.newestToken.set(cacheKey, { iat, fingerprint });
  }

  /**
   * Reserved — arbitrary-tenant accessor for cron / admin paths. Not yet
   * wired: bridge-api doesn't expose a tenant-by-id snapshot endpoint that
   * accepts the workspace API key. Use `fromJwt(userJwt)` for the
   * request-scoped path.
   */
  tenant(_tenantId: string): never {
    throw new Error(
      '[bridge-nestjs] `bridge.tenant(tenantId)` requires a bridge-api admin snapshot endpoint that accepts the workspace API key — not yet implemented. Use `bridge.fromJwt(userJwt)` from your request handler instead.',
    );
  }
}
