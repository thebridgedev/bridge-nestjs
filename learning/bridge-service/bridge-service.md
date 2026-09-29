# Reading tenant data with `BridgeService`

`BridgeService` gives a request handler one place to read everything Bridge knows about the **current
request's tenant**: its subscription, entitlements, branding, and user, without hand-rolling REST calls
to the Bridge API.

Two things to know:

1. **It reads on demand and caches.** Each tenant's data is fetched over REST and cached briefly. There
   are no push updates on the server; to react to a change (e.g. a plan upgrade), use Bridge **webhooks**.
2. **It's per request.** Every request carries a different tenant. You hand it the request (or the
   user's token) and get back a scope bound to *that* user's tenant, only once the token is verified.

## Setup

`BridgeService` is provided and exported automatically by `BridgeModule.forRoot()` /
`forRootAsync()`, so there is no extra wiring. Just inject it.

```typescript
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { BridgeAuthGuard, BridgeService } from '@nebulr-group/bridge-nestjs';

@Controller('account')
@UseGuards(BridgeAuthGuard)
export class AccountController {
  constructor(private readonly bridge: BridgeService) {}

  @Get('billing-summary')
  async summary(@Req() req: Request) {
    const tenant = this.bridge.fromRequest(req);
    const sub = await tenant.subscription;
    return { plan: sub.plan.name, status: sub.status };
  }
}
```

Reading is for showing and computing. Deciding who may use a feature is a flag
(`@RequireFeatureFlag`), see [Gating features by subscription](#gating-features-by-subscription).

## `bridge.fromRequest(req)`

The usual path. On a route behind `BridgeAuthGuard` (per route or global), `fromRequest` returns a
tenant scope for the user the guard authenticated, reusing the token the guard already verified. It
throws if the guard didn't verify a user token on this request (an unguarded or `@Public()` route, or an
API-token-only caller); it never falls back to reading a header.

## `bridge.fromJwt(userJwt)`

For a token you hold some other way (strip the `Bearer ` prefix). `fromJwt` verifies the token exactly as
`BridgeAuthGuard` does (signature against the Bridge JWKS, issuer, audience = your app id, expiry)
before any claim in it is used. The call itself stays synchronous; every read on the returned scope waits
for verification, and a token that fails verification rejects each read with `TokenVerificationError`:
no data is returned, and no cached data is read, written or evicted for it.

Either way, the verified token is forwarded to the Bridge API on the data fetch; the API derives the
tenant from the token and returns the matching data. Requests for the same user are deduped onto a single
round-trip.

> `bridge.tenant(tenantId)` (for accessing an arbitrary tenant from cron/admin code) is **not yet
> available** and throws a clear error if called. Use `bridge.fromRequest(req)` from a request handler.

## What you can read

The first access to any field triggers one fetch that returns subscription + entitlements + branding +
user together. The result is cached (default **30s**); concurrent callers share the in-flight fetch.
A newer token for the same user starts a fresh fetch, so a plan change shows up on the user's next
request with their refreshed token. Every field below resolves lazily off that single fetch.

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
const label = `${sub.plan.name} (${sub.status})`; // e.g. for an invoice header
```

### `tenant.entitlements`

The plan's features, read directly. This is a direct plan-feature check; see
[Exceptions](#exceptions--reading-plan-features-directly) for when to use it.

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

A feature a plan sells is gated by a flag, like every other gate: list the feature on the plans that
sell it (`bridge plan feature add pro pdf_export`), rule the flag
`bridge:billing.entitlement.pdf_export eq true`, and put `@RequireFeatureFlag('pdf-export')` on the
handler. A workspace without it gets `402 FEATURE_NOT_IN_PLAN` with the upgrade route. There is no
checkout or paywall in a backend plugin; purchase and upgrade flows live in your frontend and in the
Bridge API (webhooks drive the subscription lifecycle). Plan limits (numbers) are `@RequireQuota`; see
[Plan limits](../plan-limits/plan-limits.md).

## Exceptions — reading plan features directly

For the rare case where the developer explicitly asks for no flag, `tenant.entitlements` answers the
plan's features directly:

| Method | Behavior |
|---|---|
| `can(key): Promise<boolean>` | Loads the data if needed, then answers. |
| `snapshot(): Promise<Record<string, boolean>>` | The full entitlements map; fetches on first call. |
| `canSync(key, cached): boolean` | Synchronous check against a map from a prior `snapshot()`. |

```typescript
if (!(await this.bridge.fromRequest(req).entitlements.can('pdf-export'))) {
  throw new ForbiddenException();
}
```

## Caching notes

- Default cache lifetime is **30s**. The same cache is injectable directly via `BRIDGE_PULL_CACHE` for
  other REST data you want to dedupe (see the README's "Read modes: channel vs pull" section).
- A user's cached snapshot is dropped as soon as a newer token for that user arrives. Bridge re-issues
  a user's token when their plan, role or entitlements change, and the frontend SDKs pick it up within a
  second, so flag rules on plan features follow an upgrade without waiting out the 30s.
- To react to a billing change (a plan upgrade, a cancellation), use Bridge **webhooks** rather than
  polling.

## See also

- [Configuration](../configuration/configuration.md): route rules and guard setup
- [Feature flags](../feature-flags/feature-flags.md): every gate is a flag
- [Multi-tenancy](../multi-tenancy/multi-tenancy.md): tenant context fundamentals
