# Bridge NestJS — Billing & Entitlements

You are adding **server-side billing enforcement** to a NestJS application that uses The Bridge.

## The one rule for app code

**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains "USER_WRITE"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.

Two things are not gates and are not flags: **numbers** are plan limits (`<QuotaGate>` in the browser, `@RequireQuota` on the backend), and **permission on one specific record** stays in app code ("only the author edits their post").

Before calling the work done, run `npx @nebulr-group/bridge-cli check gates` in the project. It lists every direct role, privilege, plan or plan-feature check with the flag to use instead. Fix each one.

In NestJS, an endpoint is `@RequireFeatureFlag('…')` on the handler (or a route rule with `featureFlag`).

## What this guide covers

`bridge guide mechanisms` is the one-page model: the server decides and the client decorates, a POST increments the limit, counter vs gauge in one sentence, and the three ways a frontend shows a limit.

> **What "billing" means on the backend.** A backend plugin **reads** subscription state and **enforces** entitlements — nothing more. There is no checkout, no paywall, no plan-selector, and no Stripe redirect here. Purchasing lives entirely in the **frontend** Bridge plugin (the plan selector + Stripe Checkout) and in **bridge-api** (Stripe webhooks that sync plan/subscription state). This guide covers two things only: (1) reading the current tenant's subscription, and (2) gating server behavior on what the tenant's plan sells — through flags ruled on plan features, and quotas for the numbers. Do not add purchasing, checkout URLs, or Stripe client code to the backend. It also documents how to **configure** the plans, prices and quotas you gate on — that is platform configuration done over MCP or the CLI, not code you write into the app.

Team/workspace management is likewise out of scope — the backend surface is read-only and exposes no team CRUD. Member management is driven from the frontend plugin and bridge-api.

## Decide first — gating, reading, or configuring?

Three unrelated jobs land in this one guide, on three different surfaces. Confusing them is the usual wrong turn — most of all writing application code for something that is platform configuration.

| What you are doing | Surface |
|---|---|
| Enforce a plan limit on the handler that creates the thing | `@RequireQuota('<metric>')`, and `@SyncQuota` on the delete for things that exist — see **Plan limits** |
| Keep a count of things that exist in step after a delete | `@SyncQuota(metric, { current })` |
| Check or hold a limit by hand (bulk jobs, mid-handler) | `BridgeQuotaService` — `hold`, `assertQuota`, `check`, `record`, `sync` |
| Count usage by hand (workers) | `BridgeService.count(actor, metric, n)` |
| Refuse a handler unless the tenant's plan includes a feature | `@RequireFeatureFlag('<feature>')`, the flag ruled `bridge:billing.entitlement.<feature> eq true` — see **Plan features are flags** |
| Refuse a whole path unless the plan includes a feature | `featureFlag: '<feature>'` on a route rule in `BridgeModule.forRoot()`, same flag rule |
| Read the tenant's plan, status, user or branding | `bridge.fromRequest(req).subscription` / `.user` / `.branding` |
| Create the plans, prices and quotas you gate on | **Not code.** MCP tools or the `bridge` CLI — see **Configuring plans** |
| Connect Stripe so any of it bills | **Not code.** `connect_stripe` / `setup_payments` (MCP) or `bridge stripe connect` (CLI) |
| Sell something — checkout, plan selector, Stripe redirect | **Not here at all.** Frontend plugin + bridge-api |

**Gate on what a plan sells, never on the plan's name.** List the feature on the plans that sell it (`bridge plan feature add <plan> <feature>`) and rule the flag on `bridge:billing.entitlement.<feature> eq true`. A feature key survives a plan rename and a new plan; a plan name does not.

## Prerequisites

1. `@nebulr-group/bridge-nestjs` installed and `BridgeModule.forRoot()` registered (see `integration-prompt.md`).
2. Plans and Stripe are already configured on the Bridge app (done in the frontend/master billing flow). Confirm with `list_plans` (MCP) or `bridge plan list` (CLI) — at least one plan should exist.
3. Routes are protected — flags and quotas are evaluated for a verified user JWT, so the caller must be authenticated.

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

The server is authoritative; the frontend's quota display is decoration. Anyone can call your API directly, so the limit lives on the handler. One decorator holds a unit of the limit before the handler runs and counts it after the handler succeeds: there is nothing else to wire, and a curl call is refused exactly like a click.

Decide one thing per metric: **if deleting it frees room, it's a gauge and your app counts it; if it happened, it's a counter and Bridge counts it.**

| | Counter | Gauge |
|---|---|---|
| Is… | something that **happened** — an export, an API call, an AI completion | something that **exists** — tickets, projects, stored files |
| Who counts | Bridge, one unit per successful request; resets each billing period | **Your app** — you pass `current`; never resets |
| Quota config | `--kind counter` (the default) | `--kind gauge` |
| Decorator | `@RequireQuota('exports')` | `@RequireQuota('tickets', { current })` on create, `@SyncQuota('tickets', { current })` on delete |

```ts
import { Controller, Delete, Param, Post } from '@nestjs/common';
import { CurrentActor, RequireFlag, RequireQuota, SyncQuota } from '@nebulr-group/bridge-nestjs';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  // A gauge: tickets exist, so the app counts them.
  @Post()
  @RequireQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  create(@CurrentActor('workspaceId') workspaceId: string) {
    return this.tickets.create(workspaceId);
  }

  // Deleting one frees room: after a 2xx the gauge is set to the new count.
  @Delete(':id')
  @SyncQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  remove(@CurrentActor('workspaceId') workspaceId: string, @Param('id') id: string) {
    return this.tickets.remove(workspaceId, id);
  }

  // A counter: exports happen, so Bridge counts them. Who may export is a flag; how many is the quota.
  @Post(':id/export')
  @RequireFlag('exports-enabled')
  @RequireQuota('exports')
  export(@Param('id') id: string) {
    return this.tickets.export(id);
  }
}
```

`current` receives a `QuotaTenant` (`t.id` is the verified workspace id, `t.userId` the person, `t.actor` the verified caller) and the **controller instance**, so it can reach the controller's injected services. Return your own count: after a 2xx the gauge is set to it, so it heals itself if Bridge's copy ever missed an update. There is no decrement: every create and delete sends the whole current count.

- **Before the handler:** Bridge holds one unit for this request, so two requests never get the last one. At the limit the answer is `402 QUOTA_EXCEEDED` with `metric`, `used`, `limit` and `fix`, the app's subscription page (`manageRoute` in `BridgeModule.forRoot`). A `metered` quota never refuses. A metric with no quota on the plan is unlimited.
- **After the handler:** on a **2xx** the unit counts. A handler that throws or answers 4xx/5xx gives the unit back and records nothing. A hold Bridge already gave back (a handler slower than 120 seconds) is logged and never fails the response.
- **Idempotency:** a request's `Idempotency-Key` header makes a retry reuse the unit still held for that key, for the same workspace and metric. Without the header, every request holds its own unit.
- **Locked workspace:** answered `402 BILLING_GATE_ENGAGED` (`reason: "billing_locked"`).
- **Fail-closed:** if Bridge cannot answer, the request is refused with `503 QUOTA_UNAVAILABLE`.
- Needs the module's `appKey` and a caller verified by `BridgeAuthGuard` that acts in a workspace; a `@Public()` route answers 401.

**The refusal the frontend reads** — 402 Payment Required:

```json
{ "statusCode": 402, "code": "QUOTA_EXCEEDED", "message": "Your plan allows 5 tickets; 5 are in use.",
  "metric": "tickets", "used": 5, "limit": 5, "fix": "/subscription" }
```

`fix` is your subscription page; change it with `BridgeModule.forRoot({ manageRoute: '/account/billing' })`.

A limit can also be a flag ruled on `bridge:billing.quota.<metric>.limit`, gated with `@RequireFlag` and counted with `@Meter`; it refuses with `402 FEATURE_NOT_IN_PLAN`. Use one or the other for a metric, not both.

Separately, the guard refuses a signed-in person's writes in a workspace that is suspended or scheduled for deletion (403 `urn:bridge:problem:workspace-not-active`) or locked for payment (402 `urn:bridge:problem:billing-locked`), and answers 503 while Bridge cannot tell. Reads always pass.

## Plan features are flags

Whole paths and single handlers are gated the same way: by a flag whose rule names the plan feature.

1. List the feature on the plans that sell it: `bridge plan feature add pro reports` (and `enterprise`, …).
2. Create the flag `reports` with the rule `bridge:billing.entitlement.reports eq true` (see `feature-flags-prompt.md`).
3. Ask the flag — on a handler or controller with `@RequireFeatureFlag('reports')`, or on a whole path with a route rule:

```ts
BridgeModule.forRoot({
  // appId / apiBaseUrl come from BRIDGE_APP_ID / BRIDGE_API_BASE_URL when omitted.
  guard: {
    global: true,
    defaultAccess: 'protected',
    rules: [
      { path: '/reports/*', privilege: 'AUTHENTICATED', featureFlag: 'reports' },
      { path: '/exports/*', privilege: 'AUTHENTICATED', featureFlag: 'data_export' },
    ],
  },
}),
```

A caller whose plan does not include the feature is refused before the handler runs with **402 `FEATURE_NOT_IN_PLAN`**, naming the flag and the `fix` route, so the frontend can upsell. A flag that cannot be evaluated denies (fail-closed). A rule's `privilege` is only `'ANONYMOUS'` or `'AUTHENTICATED'`; the older plan-list and entitlement fields on route rules were removed, and a config that still passes one fails at startup naming the flag to use.

Moving a feature to another plan is then `bridge plan feature add` / `rm`, with no release.

### `BridgeService` — the tenant behind the request

`BridgeService` is the server-side counterpart of the frontend `bridge` object. Inject it, then call `bridge.fromRequest(req)` on a route behind `BridgeAuthGuard` to get a request-scoped `TenantScope` for the tenant of the user the guard verified. The scope fetches `GET {apiBaseUrl}/session/init` **once** (forwarding the verified JWT as `Authorization: Bearer` plus the `x-app-id` header) and caches the result via auth-core's `BridgePullCache` (default 30s TTL), so all slices share a single round-trip.

**Never read the raw `Authorization` header yourself.** Behind the guard, use `fromRequest(req)`. `bridge.fromJwt(token)` exists for a token you hold some other way; it verifies the token exactly as the guard does before any claim is used, and a token that fails rejects every read with `TokenVerificationError` (TBP-673).

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

### Usage by hand

`@RequireQuota` covers the usual case. For a hold you control (a bulk job, a check in the middle of a handler), inject `BridgeQuotaService`: `hold(req, metric, { quantity?, idempotencyKey? })` returns a unit to `confirm()` or `giveBack()`, `assertQuota` and `check` read without holding, and `record` and `sync` write. When you report usage yourself — a metered quantity that is not one-per-request, say, or a count from a worker — call `BridgeService.count(actor, metric, quantity)`. Pass a stable `id` option (`{ id: entityId }`) so a retried request cannot double-bill.

Count usage once, where the action happens: an action that calls this backend is counted here, and the frontend then reports nothing for it. An action that never reaches a server is counted by the frontend plugin — that is first-class, and it trusts the browser. The per-unit **price** is configuration, set via `set_plan_quota` with `policy: "metered"` and `priceAmount` (MCP) or `bridge plan quota set <key> --policy metered --price-amount <n>` (CLI) — see "Configuring plans" above. Bridge meters and bills it through Stripe. Do not add Stripe code here.

#### Do not build a `/quota` endpoint for your frontend

| | |
|---|---|
| **Your backend** | Enforces the cap and records usage — `@RequireQuota` / `@SyncQuota`, or `BridgeQuotaService` by hand. |
| **The frontend** | Reads quota **directly from Bridge** — `useQuota(metric)` in bridge-svelte, or the ready-made `<BridgeQuotaBanner metric="…" />` — and opens its upgrade dialog on your `402` by itself. |

So your API does **not** need a route that relays quota to your own UI. A `GET /quota` proxy plus a hand-written mirror of its shape silently drifts from the real one.

#### `hard` and `metered` behave oppositely

`hard` blocks at the limit. `metered` **never** blocks — units above `limit` bill per unit, so refusing the action on a metered plan means refusing money the customer already agreed to spend.

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

## Invalidating after a change

The snapshot is cached for the TTL. After an action that you know changes plan state in the same request (rare on the backend — usually the Stripe webhook in bridge-api drives this), force a refresh on next access:

```ts
const tenant = this.bridge.fromRequest(req);
tenant.invalidate();           // drops the cached snapshot
const fresh = await tenant.subscription;
```

Normally you don't call this — the 30s TTL keeps state fresh. Backend code should react to billing changes via Bridge **webhooks** (event-driven), not by polling.

## Exceptions — a direct plan-feature check

Only when the developer explicitly asks for no flag: `@RequireEntitlement('<feature>')` on a handler or controller refuses with 403 `ENTITLEMENT_REQUIRED` unless the plan includes the feature, and in a service or worker `BridgeQuotaService.assertEntitlement(req, '<feature>')` does the same. Both ask the flag `bridge:billing.entitlement.<feature>`, never the plan itself, and fail closed (503 `ENTITLEMENT_UNAVAILABLE` when flags cannot be read). Prefer the flag. Never pair it with `@RequireQuota` on the same metric.

## Checklist

- [ ] `list_plans` / `bridge plan list` returns at least one plan (plans configured via the frontend/master billing flow)
- [ ] Stripe is connected on the app — `get_stripe_status` (MCP) or `bridge stripe status` (CLI); if it isn't, `connect_stripe` / `setup_payments` or `bridge stripe connect` does it, with keys the user supplies
- [ ] No checkout / paywall / Stripe client code added to the backend — purchasing stays in the frontend + bridge-api
- [ ] Every handler that creates a limited thing carries `@RequireQuota('…')`, and the delete of a counted thing carries `@SyncQuota`
- [ ] Every plan-feature gate is a flag ruled `bridge:billing.entitlement.<feature> eq true` — `@RequireFeatureFlag` on the handler or `featureFlag` on a route rule; no plan name compared anywhere
- [ ] `npx @nebulr-group/bridge-cli check gates` reports nothing
- [ ] No handler reads the raw `Authorization` header — `fromRequest(req)` behind the guard
- [ ] `bridge.tenant(tenantId)` is NOT used (not yet wired)
- [ ] Subscription reads use the `subscription` slice (`plan.slug`, `status`, `endsAt`, `gateEngaged`)

## Verify

1. **Build:** the project builds with no TypeScript or import errors.
2. **Limit:** with a `tickets` hard limit of N, the (N+1)th `POST` — sent with curl, not through the UI — answers 402 `QUOTA_EXCEEDED` with `metric`, `used`, `limit` and `fix`.
3. **Counting:** a request that succeeds raises Bridge's `used` for the metric by one; a request that fails (4xx/5xx) raises it by none. Two requests with the same `Idempotency-Key` sent together count once.
4. **Plan-feature gate:** a tenant whose plan does not list `reports` gets 402 `FEATURE_NOT_IN_PLAN` from a `featureFlag: 'reports'` route; after `bridge plan feature add <its plan> reports` it gets 200, with no release.
5. **Subscription read:** `GET /billing/status` returns the tenant's current `plan`, `status`, and `endsAt` matching the dashboard.
6. **Fail-closed:** a flag that does not exist is off, so its route is refused, not opened.
