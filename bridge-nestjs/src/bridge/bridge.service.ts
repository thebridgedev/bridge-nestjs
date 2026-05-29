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

import { Inject, Injectable } from '@nestjs/common';
import { BridgePullCache } from '@nebulr-group/bridge-auth-core';

import { BRIDGE_PULL_CACHE } from '../flags/flags.tokens';
import { BRIDGE_OPTIONS, type BridgeModuleOptions } from './bridge.tokens';
import { TenantScope } from './tenant-scope';

function decodeJwtSub(jwt: string): string {
  // Best-effort: pluck `sub` for cache keying. We don't verify signature
  // here — that's the bridge-api's job at the receiving end. The cache key
  // only needs to be stable per JWT.
  const part = jwt.split('.')[1];
  if (!part) return jwt; // malformed; fall back to the whole string
  try {
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json) as { sub?: string; tid?: string };
    return claims.tid ? `${claims.tid}:${claims.sub ?? ''}` : (claims.sub ?? jwt);
  } catch {
    return jwt;
  }
}

@Injectable()
export class BridgeService {
  constructor(
    @Inject(BRIDGE_OPTIONS) private readonly opts: BridgeModuleOptions,
    @Inject(BRIDGE_PULL_CACHE) private readonly cache: BridgePullCache,
  ) {}

  /**
   * Return a TenantScope for the tenant associated with `userJwt`. The JWT
   * is forwarded to bridge-api on the snapshot fetch — the API derives the
   * tenant from the token (req.bridgeTenant) and returns the matching
   * snapshot. Caching is keyed on the JWT's `tid:sub` claim so two
   * concurrent requests for the same user share one round-trip.
   */
  fromJwt(userJwt: string): TenantScope {
    const cacheKey = decodeJwtSub(userJwt);
    return new TenantScope(
      userJwt,
      cacheKey,
      this.cache,
      this.opts.apiBaseUrl,
      this.opts.appId,
    );
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
