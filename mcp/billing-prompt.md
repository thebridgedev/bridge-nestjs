# Bridge NestJS — Billing & Entitlements

You are adding **server-side billing enforcement** to a NestJS application that uses The Bridge.

`bridge guide mechanisms` is the one-page model: the server decides and the client decorates, a POST increments the limit, counter vs gauge in one sentence, and the three ways a frontend shows a limit.

> **What "billing" means on the backend.** A backend plugin **reads** subscription state and **enforces** entitlements — nothing more. There is no checkout, no paywall, no plan-selector, and no Stripe redirect here. Purchasing lives entirely in the **frontend** Bridge plugin (the plan selector + Stripe Checkout) and in **bridge-api** (Stripe webhooks that sync plan/subscription state). This guide covers two things only: (1) reading the current tenant's subscription, and (2) gating server behavior on the tenant's plan and entitlements. Do not add purchasing, checkout URLs, or Stripe client code to the backend. It also documents how to **configure** the plans, prices and quotas you gate on — that is platform configuration done over MCP or the CLI, not code you write into the app.

Team/workspace management is likewise out of scope — the backend surface is read-only and exposes no team CRUD. Member management is driven from the frontend plugin and bridge-api.

## Decide first — gating, reading, or configuring?

Three unrelated jobs land in this one guide, on three different surfaces. Confusing them is the usual wrong turn — most of all writing application code for something that is platform configuration.

| What you are doing | Surface |
|---|---|
| Enforce a plan limit on the handler that creates the thing | `@RequireQuota(metric)` — see **Plan limits** |
| Keep a count of things that exist in step after a delete | `@SyncQuota(metric, { current })` |
| Refuse a handler unless the tenant's plan includes a capability | `@RequireEntitlement(key)` |
| Refuse a whole path unless the tenant is on a plan | `plans: [...]` on a route rule in `BridgeModule.forRoot()` |
| Refuse a whole path unless the tenant holds an entitlement | `entitlement: '…'` on that same route rule |
| Gate one capability from a service or a worker | `BridgeQuotaService.assertEntitlement(req, key)` / `bridge.fromRequest(req).entitlements.can(key)` |
| Read the tenant's plan, status, user or branding | `bridge.fromRequest(req).subscription` / `.user` / `.branding` |
| Check or record a limit by hand (bulk jobs, mid-handler) | `BridgeQuotaService` — `assertQuota`, `check`, `record`, `sync` |
| Meter usage, or read the live quota, at the lowest level | `tenant.usage.report(metric, n, key)` / `tenant.usage.set(metric, count)` / `tenant.usage.quota(metric)` |
| Create the plans, prices and quotas you gate on | **Not code.** MCP tools or the `bridge` CLI — see **Configuring plans** |
| Connect Stripe so any of it bills | **Not code.** `connect_stripe` / `setup_payments` (MCP) or `bridge stripe connect` (CLI) |
| Sell something — checkout, plan selector, Stripe redirect | **Not here at all.** Frontend plugin + bridge-api |

**Prefer an entitlement key to a plan slug.** `plans:` gates on the canonical Billing 2.0 subscription: a workspace with no canonical subscription resolves no slug and is denied 402 whatever plan it is actually on, so on an app not yet migrated to Billing 2.0 a `plans:` rule rejects your entire customer base (TBP-614). Entitlement keys also survive a plan rename; slugs do not. For a per-app plan, gate on a feature flag with a `tenant.plan` rule instead — see `feature-flags-prompt.md`.

## Prerequisites

1. `@nebulr-group/bridge-nestjs` installed and `BridgeModule.forRoot()` registered (see `integration-prompt.md`).
2. Plans and Stripe are already configured on the Bridge app (done in the frontend/master billing flow). Confirm with `list_plans` (MCP) or `bridge plan list` (CLI) — at least one plan should exist.
3. Routes are protected — entitlement gating runs on a verified user JWT, so the caller must be authenticated.

> **Check Stripe is connected before configuring anything.** If it isn't, nothing you configure will bill.
>
> | Channel | Read status | Connect |
> |---|---|---|
> | MCP | `get_stripe_status` | `connect_stripe`, or `setup_payments` for the whole flow |
> | CLI | `bridge stripe status` | `bridge stripe connect --secret-key <sk_…> --publishable-key <pk_…>` |
>
> Connecting means handing over a live Stripe secret key. Ask the user for it — never invent one, and never read it out of a file you happened to find. If they would rather not paste a secret into a chat, the dashboard is the third option.

## Configuring plans — MCP, CLI, or dashboard

Plans, prices and quotas are **platform configuration**, not application code. Bridge exposes them over **two channels an agent can drive**, both hitting the same management API, so the result is identical:

| Operation | MCP tool | CLI |
|---|---|---|
| List plans (with prices + quotas) | `list_plans` | `bridge plan list` |
| Inspect one plan | `get_plan` | `bridge plan get <key>` |
| Create a plan | `create_plan` | `bridge plan create --key <k> --name <n>` |
| Rename / re-describe a plan | `update_plan` | `bridge plan update --key <k> --name <n>` |
| Add or replace a recurring price | `set_plan_price` | `bridge plan price set <key> --amount <n> --interval <i>` |
| Remove a price | `remove_plan_price` | `bridge plan price rm <key> --interval <i>` |
| Add or replace a usage quota | `set_plan_quota` | `bridge plan quota set <key> --metric <m> --limit <n> --policy <p> [--kind counter\|gauge]` |
| Remove a quota | `remove_plan_quota` | `bridge plan quota rm <key> --metric <m>` |
| List a plan's quotas | `list_plan_quotas` | `bridge plan quota list <key>` |
| Check Stripe is connected | `get_stripe_status` | `bridge stripe status` |
| **Connect Stripe** | `connect_stripe`, or `setup_payments` for the whole flow | `bridge stripe connect` |

**Use whichever you actually have.** If the user asked for a specific one, use that one — no reason to argue, both reach the same API. If you have both and the user expressed no preference, either is correct; pick one and stay on it for the whole task.

The **dashboard is a last resort**, not a third equal option. Only walk the user through the UI when neither MCP nor CLI is available *and* they don't want to install one — or when the user would rather not paste a live Stripe secret key into a chat, which is the one honest reason to send them to the UI for `connect_stripe`.

### The common shape: free hard cap + premium metered overage

Two `set_plan_quota` calls on the same metric, differing only in `policy`:

```jsonc
// Free — requests past the cap are refused.
{ "key": "free",    "metric": "api_calls", "limit": 1000,  "policy": "hard" }

// Premium — 50k included, everything beyond it billed per unit through Stripe.
{ "key": "premium", "metric": "api_calls", "limit": 50000, "policy": "metered", "priceAmount": 0.002 }
```

`limit` is the number of included units — a hard ceiling under `policy: "hard"`, and the free allowance before per-unit billing kicks in under `"metered"` (`limit: 0` bills from the first unit). `priceAmount` must be `> 0` for `metered` and must **not** be set for `hard`. `priceCurrency` is optional: it defaults to the plan's price currency when that is unambiguous, so add a price to the plan (`set_plan_price`) before adding a metered quota. Same thing on the CLI: `bridge plan quota set premium --metric api_calls --limit 50000 --policy metered --price-amount 0.002`.

## Plan limits — one decorator on the handler that creates the thing

The server is authoritative; the frontend's quota display is decoration. Anyone can call your API directly, so the limit lives on the handler. One decorator checks the limit before the handler runs and records usage after it succeeds — there is nothing else to wire, and a curl call is refused exactly like a click.

Decide one thing per metric: **if deleting it frees room, it's a gauge and your app counts it; if it happened, it's a counter and Bridge counts it.**

| | Counter | Gauge |
|---|---|---|
| Is… | something that **happened** — an export, an API call, an AI completion | something that **exists** — tickets, projects, stored files |
| Who counts | Bridge, from the events you report; resets each billing period | **Your app** — you pass `current`; never resets |
| Quota config | `--kind counter` (the default) | `--kind gauge` |
| Decorator | `@RequireQuota('exports')` | `@RequireQuota('tickets', { current })` on create, `@SyncQuota('tickets', { current })` on delete |

```ts
import { Body, Controller, Delete, Param, Post } from '@nestjs/common';
import {
  BridgeTenant,
  CurrentTenant,
  RequireEntitlement,
  RequireQuota,
  SyncQuota,
} from '@nebulr-group/bridge-nestjs';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  // Gauge: refused with 402 when the app already has `limit` tickets; after a
  // 2xx the plugin sets Bridge's copy of the count.
  @Post()
  @RequireQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  create(@CurrentTenant() tenant: BridgeTenant, @Body() body: CreateTicketDto) {
    return this.tickets.create(tenant.id, body);
  }

  // No check; after a 2xx the gauge is set to the new, lower count.
  @Delete(':id')
  @SyncQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  remove(@CurrentTenant() tenant: BridgeTenant, @Param('id') id: string) {
    return this.tickets.remove(tenant.id, id);
  }

  // Counter: Bridge's tally is compared; one event is reported after a 2xx.
  @Post(':id/export')
  @RequireEntitlement('app_active')
  @RequireQuota('exports')
  export(@Param('id') id: string) {
    return this.tickets.export(id);
  }
}
```

The first argument of `current` is a `QuotaTenant` (exported from `@nebulr-group/bridge-nestjs`), not the `BridgeTenant` that `@CurrentTenant()` gives a handler: it carries the verified workspace `id` and `userId`. Leave it unannotated as above, or write `(t: QuotaTenant, self: TicketsController) => …`; annotating it as `BridgeTenant` does not compile.

`current` receives the tenant (`t.id` is the verified workspace id, `t.userId`, `t.scope` the full `TenantScope`) and the **controller instance**, so it can reach the controller's injected services. Return your own count — it is what the limit is compared against, so it heals itself if Bridge's copy ever missed an update. There is no decrement and no reservation: every create and delete sends the whole current count.

**What happens, exactly:**

- **Before the handler:** `@RequireEntitlement` first (403), then the quota (402). A `metered` quota never refuses — past its allowance it bills. A metric with no quota on the plan is unlimited.
- **After the handler:** only when the response is **2xx**. A handler that throws, or answers 4xx/5xx, records nothing. **Exactly one write** to Bridge per decorated metric: a gauge `PUT` or a counter event.
- **Idempotency:** a counter is keyed by the request's `Idempotency-Key` header. The same key from the same workspace for the same metric is one event, however often the client retries. Without the header, every successful request counts.
- **Needs a verified user.** Put the route behind `BridgeAuthGuard` (or the global guard). A `@Public()` route or an API-token-only caller has no workspace and gets 401.
- **Fail-closed:** if Bridge cannot answer the quota or entitlement read, the request is refused with 503 — never let through unchecked.

**The refusal the frontend reads** — 402 Payment Required:

```json
{ "statusCode": 402, "code": "QUOTA_EXCEEDED", "message": "Your plan allows 5 tickets; 5 are in use.",
  "metric": "tickets", "used": 5, "limit": 5, "fix": "/subscription" }
```

and for an entitlement, 403: `{ "statusCode": 403, "code": "ENTITLEMENT_REQUIRED", "entitlement": "…", "fix": "/subscription", "message": "…" }`. `fix` is your subscription page; change it with `BridgeModule.forRoot({ billing: { manageRoute: '/account/billing' } })`.

> **Every hard quota is also an entitlement** with the same name (dots become `_`), true while `used < limit`. So never pair `@RequireEntitlement('exports')` with `@RequireQuota('exports')`: at the cap it answers 403 before the quota can answer the 402 your frontend knows how to upsell. Use `@RequireEntitlement` for a capability (`app_active`, a feature key), `@RequireQuota` for the limit.

> **Seats** (`users`) are a gauge Bridge keeps itself from workspace membership. `@RequireQuota('users')` on your invite handler checks the seat limit and writes nothing.

> **A plan feature is a `hard` quota nothing counts.** There is no separate entitlement setting: `bridge plan quota set pro --metric analytics --limit 1 --policy hard` makes `analytics` true on `pro`, and a plan without it answers false. Gate it with `@RequireEntitlement('analytics')`. `app_active` is always present: true while the subscription is active, trialing, past due or cancelling at period end.

### Without decorators — `BridgeQuotaService`

Everything the decorators do is a plain call, for bulk operations, workers, or a check in the middle of a handler:

```ts
// import { BridgeQuotaService, QuotaExceededException } from '@nebulr-group/bridge-nestjs';
constructor(private readonly quota: BridgeQuotaService) {}

async importTickets(req: Request, rows: Row[]) {
  const tenantId = this.quota.tenantIdFor(req); // the verified workspace id
  const have = await this.tickets.countFor(tenantId);
  const d = await this.quota.check(req, 'tickets', { current: have + rows.length - 1 });
  if (!d.allowed) throw new QuotaExceededException(this.quota.quotaExceededBody('tickets', have, d.limit!));
  await this.tickets.insertMany(tenantId, rows);
  await this.quota.sync(req, 'tickets', () => this.tickets.countFor(tenantId)); // one PUT
}
```

| Call | Does |
|---|---|
| `check(req, metric, { current? })` | Decides without refusing → `{ allowed, used, limit, quota }` |
| `assertQuota(req, metric, { current? })` | Refuses with the 402 above |
| `record(req, metric, { current? \| value?, idempotencyKey? })` | One write: gauge set, or counter event. Never throws |
| `sync(req, metric, current)` | Sets the gauge — the `@SyncQuota` call |
| `assertEntitlement(req, key)` | Refuses with the 403 above |

At the lowest level, `bridge.fromRequest(req).usage` has `quota(metric)`, `report(metric, n, key)` and `set(metric, count)`.

## Gating whole paths and capabilities

There are two more layers, declarative and programmatic. Use whichever fits.

| Layer | Where | Best for |
|---|---|---|
| **Declarative** — `plans: [...]` / `entitlement: '…'` on a route rule | `BridgeModule.forRoot` guard config | Whole paths gated by plan tier or by one entitlement |
| **Decorator** — `@RequireEntitlement(key)` | On a handler or controller | One capability, with a structured 403 |
| **Programmatic** — `BridgeService.fromRequest(req).entitlements.can(key)` | Inside a handler/service | Fine-grained per-feature / per-action gates |

### Declarative — plan- and entitlement-restricted routes

Add `plans` to a route rule; the tenant's subscription plan must be in the list. Combine with a `privilege`:

```ts
BridgeModule.forRoot({
  // appId / apiBaseUrl come from BRIDGE_APP_ID / BRIDGE_API_BASE_URL when omitted.
  guard: {
    global: true,
    defaultAccess: 'protected',
    rules: [
      { path: '/reports/*', privilege: 'TENANT_READ', plans: ['pro', 'enterprise'] },
      { path: '/exports/*', privilege: 'TENANT_WRITE', plans: ['enterprise'] },
    ],
  },
}),
```

A caller whose tenant is on `free` hits `/reports/...` and is rejected before the handler runs, with **402 Payment Required** and `reason: 'plan_required'`.

The same rule takes `entitlement`, a key or an array of keys the tenant must hold **all** of — denied with 402 `reason: 'entitlement_missing'`:

```ts
{ path: '/exports/*', privilege: 'TENANT_WRITE', entitlement: 'data_export' },
```

Both are **fail-closed**: if the subscription snapshot cannot be resolved, the request is denied. And both read the canonical Billing 2.0 subscription — see the warning in **Decide first** before reaching for `plans`.

### Programmatic — `BridgeService`

`BridgeService` is the server-side counterpart of the frontend `bridge` object. Inject it, then call `bridge.fromRequest(req)` on a route behind `BridgeAuthGuard` to get a request-scoped `TenantScope` for the tenant of the user the guard verified. The scope fetches `GET {apiBaseUrl}/session/init` **once** (forwarding the verified JWT as `Authorization: Bearer` plus the `x-app-id` header) and caches the result via auth-core's `BridgePullCache` (default 30s TTL), so all slices share a single round-trip.

**Never read the raw `Authorization` header yourself.** Behind the guard, use `fromRequest(req)`. `bridge.fromJwt(token)` exists for a token you hold some other way; it verifies the token exactly as the guard does before any claim is used, and a token that fails rejects every read with `TokenVerificationError` (TBP-673).

```ts
import { Controller, Get, Req, UseGuards, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { BridgeAuthGuard, BridgeService } from '@nebulr-group/bridge-nestjs';

@Controller('exports')
@UseGuards(BridgeAuthGuard)
export class ExportsController {
  constructor(private readonly bridge: BridgeService) {}

  @Get()
  async export(@Req() req: Request) {
    const tenant = this.bridge.fromRequest(req);

    if (!(await tenant.entitlements.can('data_export'))) {
      throw new ForbiddenException('Your plan does not include data export.');
    }

    return this.exportService.run();
  }
}
```

> `bridge.fromRequest(req)` is the supported path. `bridge.tenant(tenantId)` (arbitrary tenant for cron/admin) is **not yet wired** and throws a clear error pointing you back to `fromRequest` — don't use it.

## Reading subscription state

`TenantScope` exposes lazy, promise-returning slices off the single cached snapshot:

```ts
const tenant = this.bridge.fromRequest(req);

const sub = await tenant.subscription;
// SubscriptionSnapshot:
//   sub.plan.slug   — e.g. 'pro'
//   sub.plan.name   — e.g. 'Pro'
//   sub.status      — e.g. 'active' | 'trialing' | 'canceled' (string)
//   sub.endsAt?     — ISO timestamp when the subscription ends (optional)
//   sub.gateEngaged? — true when access is currently gated by billing state

const user = await tenant.user;        // { id, email?, role, tenantId }
const branding = await tenant.branding; // { logo, name, primaryButtonBgColor?, ... }
```

### Usage by hand (TBP-275)

`@RequireQuota` covers the usual case. When you report usage yourself — a
metered quantity that is not one-per-request, say — the tenant scope has the
raw calls:

```ts
// Report a usage event for the current tenant (idempotency-keyed, best-effort).
await tenant.usage.report('api_calls');     // value defaults to 1
await tenant.usage.report('tokens', 1375);  // report N units

// Set a gauge to how many exist right now (rejects on failure; no decrement).
await tenant.usage.set('projects', await this.projects.countFor(tenantId));

// Read the live quota snapshot (includes metered overage estimate).
const q = await tenant.usage.quota('api_calls');
// q?.policy ('hard' | 'metered'), q?.kind ('counter' | 'gauge'); for metered: q.unitAmount, q.currency,
// q.overageEstimate, q.overcap. null when no quota is configured for the metric.
```

Reporting usage is a backend responsibility (it must be trusted); the per-unit
**price** is configuration, set via `set_plan_quota` with `policy: "metered"` and
`priceAmount` (MCP) or `bridge plan quota set <key> --policy metered
--price-amount <n>` (CLI) — see "Configuring plans" above. bridge-api meters and
bills it through Stripe. Do not add Stripe code here.

#### Do not build a `/quota` endpoint for your frontend

Read this before you expose quota to a client. The split is:

| | |
|---|---|
| **Your backend** | Enforces the cap and records usage — `@RequireQuota` / `@SyncQuota`, or `BridgeQuotaService` by hand. |
| **The frontend** | Reads quota **directly from Bridge** — `useQuota(metric)` in bridge-svelte, or the ready-made `<BridgeQuotaBanner metric="…" />` — and opens its upgrade dialog on your `402` by itself. |

So your API does **not** need a route that relays a `QuotaSnapshot` to your own
UI, and your frontend should not hand-copy the `QuotaSnapshot` shape into a local
type — the client SDK already returns it typed. A `GET /quota` proxy plus a
hand-written mirror of that interface is a common wrong turn, and it silently
drifts from the real shape the first time a field is added.

Enforcement, though, genuinely is yours alone: a client-side check is display,
not a cap. Anyone can call your API directly. Disable the button for UX **and**
refuse the write on the server.

#### `hard` and `metered` behave oppositely

`hard` blocks at the limit. `metered` **never** blocks — units above `limit`
bill per unit, so refusing the action on a metered plan means refusing money the
customer already agreed to spend. Branch on `policy`, never on `remaining` alone.

When you meter by hand, pass a stable **idempotency key** as the third argument
(`usage.report(metric, 1, entityId)`) so a retried request cannot double-bill.
`@RequireQuota` does this for you from the `Idempotency-Key` request header.

Example — surface plan and lifecycle to the client:

```ts
@Controller('billing')
@UseGuards(BridgeAuthGuard)
export class BillingController {
  constructor(private readonly bridge: BridgeService) {}

  @Get('status')
  async status(@Req() req: Request) {
    const sub = await this.bridge.fromRequest(req).subscription;
    return {
      plan: sub.plan.slug,
      status: sub.status,
      endsAt: sub.endsAt ?? null,
      gated: sub.gateEngaged ?? false,
    };
  }
}
```

## Reading entitlements

Entitlements are the granular "what can this tenant do" map, derived from the plan. `tenant.entitlements` gives you three accessors:

```ts
const ent = this.bridge.fromRequest(req).entitlements;

// Common path — loads the snapshot if needed, then answers:
const canExport = await ent.can('data_export');         // Promise<boolean>

// Full map (also loads the snapshot on first call):
const all = await ent.snapshot();                        // Record<string, boolean>

// Synchronous check against an already-loaded map (no fetch):
const map = await ent.snapshot();
const canSeats = ent.canSync('extra_seats', map);        // boolean
```

`can(key)` and `snapshot()` are **fail-closed**: an unknown key returns `false`. On a handler, `@RequireEntitlement('ai_completions')` is the one-liner. Gate the feature, not just the route, when the same capability is reachable through multiple endpoints — `BridgeQuotaService.assertEntitlement` refuses with the same structured 403:

```ts
@Injectable()
export class AiService {
  constructor(private readonly quota: BridgeQuotaService) {}

  async complete(req: Request, prompt: string) {
    await this.quota.assertEntitlement(req, 'ai_completions'); // 403 ENTITLEMENT_REQUIRED
    return this.runModel(prompt);
  }
}
```

## Invalidating after a change

The snapshot is cached for the TTL. After an action that you know changes plan or entitlement state in the same request (rare on the backend — usually the Stripe webhook in bridge-api drives this), force a refresh on next access:

```ts
const tenant = this.bridge.fromRequest(req);
tenant.invalidate();           // drops the cached snapshot
const fresh = await tenant.subscription;
```

Normally you don't call this — the 30s TTL keeps state fresh. Backend code should react to billing changes via Bridge **webhooks** (event-driven), not by polling.

## Declarative vs programmatic — which to use

- Reach for **`plans` on a route rule** when an entire path is tier-gated and you can name the allowed plans up front.
- Reach for **`@RequireQuota` / `@SyncQuota`** for every plan limit on a handler that creates or deletes the thing.
- Reach for **`@RequireEntitlement(key)`** (or `entitlements.can(key)` in code) when the gate is a named capability (not a plan slug), when the same capability is hit from several routes or a queue/cron worker, or when you want a precise 403 message. Entitlement keys are stable across plan renames; plan slugs are not.

## Checklist

- [ ] `list_plans` / `bridge plan list` returns at least one plan (plans configured via the frontend/master billing flow)
- [ ] Stripe is connected on the app — `get_stripe_status` (MCP) or `bridge stripe status` (CLI); if it isn't, `connect_stripe` / `setup_payments` or `bridge stripe connect` does it, with keys the user supplies
- [ ] No checkout / paywall / Stripe client code added to the backend — purchasing stays in the frontend + bridge-api
- [ ] Every handler that creates a limited thing carries `@RequireQuota(metric)` — with `current` for a gauge
- [ ] Every handler that deletes a gauge-counted thing carries `@SyncQuota(metric, { current })`
- [ ] No `@RequireEntitlement(m)` + `@RequireQuota(m)` pair on the same metric
- [ ] Tier-gated paths use `plans: [...]` on the route rule (with a `privilege`)
- [ ] Capability gates use `@RequireEntitlement(key)` or `entitlements.can(key)` via `fromRequest(req)` and fail closed
- [ ] No handler reads the raw `Authorization` header — `fromRequest(req)` behind the guard
- [ ] `bridge.tenant(tenantId)` is NOT used (not yet wired)
- [ ] Subscription reads use the `subscription` slice (`plan.slug`, `status`, `endsAt`, `gateEngaged`)

## Verify

1. **Build:** the project builds with no TypeScript or import errors.
2. **Limit (gauge):** with a `tickets` hard limit of N, the (N+1)th `POST` — sent with curl, not through the UI — answers 402 `QUOTA_EXCEEDED` with `used`/`limit`/`fix`; after a `DELETE`, `GET /v1/usage/quota/tickets` on Bridge shows `used` one lower and a create succeeds again.
3. **Limit (counter):** two requests with the same `Idempotency-Key` raise Bridge's `used` by one; a request that fails (4xx/5xx) raises it by none.
4. **Plan gate (declarative):** a tenant on `free` calling a `plans: ['pro']` route gets rejected; a `pro` tenant gets 200.
5. **Entitlement gate:** a tenant without the `data_export` entitlement gets 403 from the export endpoint; one with it gets 200.
6. **Subscription read:** `GET /billing/status` returns the tenant's current `plan`, `status`, and `endsAt` matching the dashboard.
7. **Fail-closed:** an unknown entitlement key resolves to `false` (the feature is denied), not an error.
