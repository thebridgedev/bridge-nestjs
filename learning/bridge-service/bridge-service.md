# Reading tenant data with `BridgeService`

`BridgeService` gives a request handler one place to read everything Bridge knows about the **current
request's tenant**: its subscription, entitlements, branding, and user, without hand-rolling REST calls
to the Bridge API.

Two things to know:

1. **It reads on demand and caches.** Each tenant's data is fetched over REST and cached briefly. There
   are no push updates on the server; to react to a change (e.g. a plan upgrade), use Bridge **webhooks**.
2. **It's per request.** Every request carries a different tenant. You pass the incoming user's JWT and
   get back a scope bound to *that* user's tenant.

## Setup

`BridgeService` is provided and exported automatically by `BridgeModule.forRoot()` /
`forRootAsync()`, so there is no extra wiring. Just inject it.

```typescript
import { Controller, Get, Headers, ForbiddenException } from '@nestjs/common';
import { BridgeService } from '@nebulr-group/bridge-nestjs';

@Controller('reports')
export class ReportsController {
  constructor(private readonly bridge: BridgeService) {}

  @Get('export')
  async export(@Headers('authorization') auth: string) {
    const tenant = this.bridge.fromJwt(auth.replace(/^Bearer\s+/i, ''));

    if (!(await tenant.entitlements.can('pdf-export'))) {
      throw new ForbiddenException('Your plan does not include PDF export');
    }

    return this.buildExport();
  }
}
```

## `bridge.fromJwt(userJwt)`

`fromJwt` takes the raw user JWT (strip the `Bearer ` prefix) and returns a tenant scope. The JWT is
forwarded to the Bridge API on the data fetch; the API derives the tenant from the token and returns the
matching data. Requests for the same user are deduped onto a single round-trip.

> `bridge.tenant(tenantId)` (for accessing an arbitrary tenant from cron/admin code) is **not yet
> available** and throws a clear error if called. Use `bridge.fromJwt(userJwt)` from a request handler.

## What you can read

The first access to any field triggers one fetch that returns subscription + entitlements + branding +
user together. The result is cached (default **30s**); concurrent callers share the in-flight fetch.
Every field below resolves lazily off that single fetch.

```typescript
interface SessionSnapshotData {
  app: { branding: BrandingSnapshot };
  tenant: {
    id: string;
    name: string;
    subscription: SubscriptionSnapshot;
    entitlements: Record<string, boolean>;
  };
  user: UserSnapshot;
}
```

### `tenant.subscription` → `Promise<SubscriptionSnapshot>`

```typescript
interface SubscriptionSnapshot {
  plan: { slug: string; name: string };
  status: string;       // e.g. 'active', 'trialing', 'canceled'
  endsAt?: string;
  gateEngaged?: boolean; // true when the plan gate is currently blocking the tenant
}

const sub = await tenant.subscription;
if (sub.plan.slug === 'free') { /* ... */ }
```

### `tenant.entitlements`

The common path is `.can(key)`:

```typescript
if (await tenant.entitlements.can('seats:10')) { /* ... */ }
```

| Method | Behavior |
|---|---|
| `can(key): Promise<boolean>` | Loads the data if needed, then answers. The usual call. |
| `snapshot(): Promise<Record<string, boolean>>` | The full entitlements map; fetches on first call. |
| `canSync(key, cached): boolean` | Synchronous check against an already-loaded map: pass the result of a prior `snapshot()`. Use when checking many keys in a hot path. |

```typescript
// Many checks without re-awaiting each time:
const ents = await tenant.entitlements.snapshot();
const canExport = tenant.entitlements.canSync('pdf-export', ents);
const canBulk   = tenant.entitlements.canSync('bulk-import', ents);
```

### `tenant.usage` (TBP-275, metered usage)

Report usage events and read live per-metric quota snapshots (including metered
overage cost) server-side, without hand-rolling the REST calls.

```typescript
// Report usage (best-effort, idempotency-keyed; never throws into the request path)
await tenant.usage.report('api_calls');        // value defaults to 1
await tenant.usage.report('tokens', 1375);     // report N units

// Read the live quota snapshot for a metric
const q = await tenant.usage.quota('api_calls');
if (q?.policy === 'metered' && q.overcap) {
  log.info(`Overage: ${q.used - q.limit} units · ~${q.overageEstimate} ${q.currency}`);
}
```

| Method | Behavior |
|---|---|
| `report(metric, value = 1, idempotencyKey?): Promise<void>` | POSTs `/usage/ingest`. Best-effort: resolves on completion, swallows transport errors. `idempotencyKey` auto-generates when omitted so accidental double-reports dedupe server-side. |
| `quota(metric): Promise<QuotaSnapshot \| null>` | Live snapshot from `/usage/quota/:metric`; `null` when no quota is configured. `QuotaSnapshot` carries `used/limit/remaining/warningLevel/policy` and, for `metered` quotas, `unitAmount/currency/overageEstimate/overcap`. |

### `tenant.branding` → `Promise<BrandingSnapshot>`

```typescript
interface BrandingSnapshot {
  logo: string;
  name: string;
  primaryButtonBgColor?: string;
  textColor?: string;
  bgColor?: string;
  fontFamily?: string;
}
```

Useful for server-rendered emails or PDFs that should carry the tenant's branding.

### `tenant.user` → `Promise<UserSnapshot>`

```typescript
interface UserSnapshot {
  id: string;
  email?: string;
  role: string;
  tenantId: string;
}
```

### `tenant.invalidate()`

Force the next access to re-fetch. Call this right after a change that affects the data (e.g. you just
upgraded the plan and want the fresh subscription):

```typescript
await upgradePlan(tenantId, 'pro');
tenant.invalidate();
const fresh = await tenant.subscription; // re-fetched
```

## Gating features by subscription

Reading the subscription and checking entitlements is how you enforce paid features server-side; there
is no checkout or paywall in a backend plugin. Purchase and upgrade flows live in your frontend and in
the Bridge API (webhooks drive the subscription lifecycle). Two ways to enforce:

Gate inside a handler with an entitlement check:

```typescript
if (!(await this.bridge.fromJwt(jwt).entitlements.can('feature-key'))) {
  throw new ForbiddenException();
}
```

## Caching notes

- Default cache lifetime is **30s**. The same cache is injectable directly via `BRIDGE_PULL_CACHE` for
  other REST data you want to dedupe (see the README's "Read modes: channel vs pull" section).
- To react to a billing change (a plan upgrade, a cancellation), use Bridge **webhooks** rather than
  polling.

## See also

- [Configuration](../configuration/configuration.md): route rules and guard setup
- [Feature flags](../feature-flags/feature-flags.md): flag-based gating (distinct from entitlements)
- [Multi-tenancy](../multi-tenancy/multi-tenancy.md): tenant context fundamentals
