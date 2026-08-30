# Bridge NestJS — Billing & Entitlements

You are adding **server-side billing enforcement** to a NestJS application that uses The Bridge.

> **What "billing" means on the backend.** A backend plugin **reads** subscription state and **enforces** entitlements — nothing more. There is no checkout, no paywall, no plan-selector, and no Stripe redirect here. Purchasing lives entirely in the **frontend** Bridge plugin (the plan selector + Stripe Checkout) and in **bridge-api** (Stripe webhooks that sync plan/subscription state). This guide covers two things only: (1) reading the current tenant's subscription, and (2) gating server behavior on the tenant's plan and entitlements. Do not add purchasing, checkout URLs, or Stripe client code to the backend. It also documents how to **configure** the plans, prices and quotas you gate on — that is platform configuration done over MCP or the CLI, not code you write into the app.

Team/workspace management is likewise out of scope — the backend surface is read-only and exposes no team CRUD. Member management is driven from the frontend plugin and bridge-api.

## Prerequisites

1. `@nebulr-group/bridge-nestjs` installed and `BridgeModule.forRoot()` registered (see `integration-prompt.md`).
2. Plans and Stripe are already configured on the Bridge app (done in the frontend/master billing flow). Confirm with `list_plans` (MCP) or `bridge plan list` (CLI) — at least one plan should exist.
3. Routes are protected — entitlement gating runs on a verified user JWT, so the caller must be authenticated.

> **Stripe connection is a human step — there is no MCP tool for it.** If Stripe isn't connected on the app, nothing you configure will bill. Connecting it means handing over live secrets, so it happens in the dashboard, or on the CLI with `bridge stripe connect --secret-key <sk_…> --publishable-key <pk_…>`. Check with `bridge stripe status`. Don't burn turns looking for an MCP tool; ask the user to do it.

## Configuring plans — MCP, CLI, or dashboard

Plans, prices and quotas are **platform configuration**, not application code. Bridge exposes them over **two channels an agent can drive**, both hitting the same management API, so the result is identical:

| Operation | MCP tool | CLI |
|---|---|---|
| List plans (with prices + quotas) | `list_plans` | `bridge plan list` |
| Inspect one plan | — read it out of `list_plans` | `bridge plan get <key>` |
| Create a plan | `create_plan` | `bridge plan create --key <k> --name <n>` |
| Rename / re-describe a plan | `update_plan` | `bridge plan update --key <k> --name <n>` |
| Add or replace a recurring price | `set_plan_price` | `bridge plan price set <key> --amount <n> --interval <i>` |
| Remove a price | `remove_plan_price` | `bridge plan price rm <key> --interval <i>` |
| Add or replace a usage quota | `set_plan_quota` | `bridge plan quota set <key> --metric <m> --limit <n> --policy <p>` |
| Remove a quota | `remove_plan_quota` | `bridge plan quota rm <key> --metric <m>` |
| List a plan's quotas | — in `list_plans` output | `bridge plan quota list <key>` |
| **Connect Stripe** | **none — human step** | `bridge stripe connect` |

**Use whichever you actually have.** If the user asked for a specific one, use that one — no reason to argue, both reach the same API. If you have both and the user expressed no preference, either is correct; pick one and stay on it for the whole task.

The **dashboard is a last resort**, not a third equal option. Only walk the user through the UI when neither MCP nor CLI is available *and* they don't want to install one — or for Stripe, which has no MCP path at all.

### The common shape: free hard cap + premium metered overage

Two `set_plan_quota` calls on the same metric, differing only in `policy`:

```jsonc
// Free — requests past the cap are refused.
{ "key": "free",    "metric": "api_calls", "limit": 1000,  "policy": "hard" }

// Premium — 50k included, everything beyond it billed per unit through Stripe.
{ "key": "premium", "metric": "api_calls", "limit": 50000, "policy": "metered", "priceAmount": 0.002 }
```

`limit` is the number of included units — a hard ceiling under `policy: "hard"`, and the free allowance before per-unit billing kicks in under `"metered"` (`limit: 0` bills from the first unit). `priceAmount` must be `> 0` for `metered` and must **not** be set for `hard`. `priceCurrency` is optional: it defaults to the plan's price currency when that is unambiguous, so add a price to the plan (`set_plan_price`) before adding a metered quota. Same thing on the CLI: `bridge plan quota set premium --metric api_calls --limit 50000 --policy metered --price-amount 0.002`.

## How backend enforcement works

There are two layers, declarative and programmatic. Use whichever fits.

| Layer | Where | Best for |
|---|---|---|
| **Declarative** — `plans: [...]` on a route rule | `BridgeModule.forRoot` guard config | Whole paths gated by plan tier |
| **Programmatic** — `BridgeService.fromJwt(jwt).entitlements.can(key)` | Inside a handler/service | Fine-grained per-feature / per-action gates |

### Declarative — plan-restricted routes

Add `plans` to a route rule; the tenant's subscription plan must be in the list. Combine with a `privilege`:

```ts
BridgeModule.forRoot({
  appId: process.env.BRIDGE_APP_ID!,
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

A caller whose tenant is on `free` hits `/reports/...` and is rejected before the handler runs.

### Programmatic — `BridgeService`

`BridgeService` is the server-side counterpart of the frontend `bridge` object. Inject it, then call `bridge.fromJwt(userJwt)` to get a request-scoped `TenantScope` for the tenant that owns the JWT. The scope fetches `GET {apiBaseUrl}/session/init` **once** (forwarding the JWT as `Authorization: Bearer` plus the `x-app-id` header) and caches the result via auth-core's `BridgePullCache` (default 30s TTL), so all slices share a single round-trip.

```ts
import { Controller, Get, Headers, ForbiddenException } from '@nestjs/common';
import { BridgeService } from '@nebulr-group/bridge-nestjs';

function stripBearer(authHeader = ''): string {
  return authHeader.replace(/^Bearer\s+/i, '');
}

@Controller('exports')
export class ExportsController {
  constructor(private readonly bridge: BridgeService) {}

  @Get()
  async export(@Headers('authorization') auth: string) {
    const tenant = this.bridge.fromJwt(stripBearer(auth));

    if (!(await tenant.entitlements.can('data_export'))) {
      throw new ForbiddenException('Your plan does not include data export.');
    }

    return this.exportService.run();
  }
}
```

> `bridge.fromJwt(userJwt)` is the supported path. `bridge.tenant(tenantId)` (arbitrary tenant for cron/admin) is **not yet wired** and throws a clear error pointing you back to `fromJwt` — don't use it.

## Reading subscription state

`TenantScope` exposes lazy, promise-returning slices off the single cached snapshot:

```ts
const tenant = this.bridge.fromJwt(jwt);

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

### Metered usage (TBP-275)

When a plan has **metered** quotas (per-unit billing), the backend is where you
**report** usage as it happens and can read the live per-metric snapshot:

```ts
// Report a usage event for the current tenant (idempotency-keyed, best-effort).
await tenant.usage.report('api_calls');     // value defaults to 1
await tenant.usage.report('tokens', 1375);  // report N units

// Read the live quota snapshot (includes metered overage estimate).
const q = await tenant.usage.quota('api_calls');
// q?.policy ('hard' | 'metered'); for metered: q.unitAmount, q.currency,
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
| **Your backend** | Enforces the cap and reports usage. `usage.quota()` to decide, `usage.report()` to meter. |
| **The frontend** | Reads quota **directly from Bridge** — `useBridge().quota(metric)` in bridge-svelte, or the ready-made `<BridgeQuotaBanner metric="…" />`. |

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

When you meter, pass a stable **idempotency key** as the third argument
(`usage.report(metric, 1, entityId)`) so a retried request cannot double-bill.

Example — surface plan and lifecycle to the client:

```ts
@Controller('billing')
export class BillingController {
  constructor(private readonly bridge: BridgeService) {}

  @Get('status')
  async status(@Headers('authorization') auth: string) {
    const sub = await this.bridge.fromJwt(stripBearer(auth)).subscription;
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
const ent = this.bridge.fromJwt(jwt).entitlements;

// Common path — loads the snapshot if needed, then answers:
const canExport = await ent.can('data_export');         // Promise<boolean>

// Full map (also loads the snapshot on first call):
const all = await ent.snapshot();                        // Record<string, boolean>

// Synchronous check against an already-loaded map (no fetch):
const map = await ent.snapshot();
const canSeats = ent.canSync('extra_seats', map);        // boolean
```

`can(key)` and `snapshot()` are **fail-closed**: an unknown key returns `false`. Gate the feature, not just the route, when the same capability is reachable through multiple endpoints or background jobs:

```ts
@Injectable()
export class AiService {
  constructor(private readonly bridge: BridgeService) {}

  async complete(userJwt: string, prompt: string) {
    if (!(await this.bridge.fromJwt(userJwt).entitlements.can('ai_completions'))) {
      throw new ForbiddenException('AI completions are not in your plan.');
    }
    return this.runModel(prompt);
  }
}
```

## Invalidating after a change

The snapshot is cached for the TTL. After an action that you know changes plan or entitlement state in the same request (rare on the backend — usually the Stripe webhook in bridge-api drives this), force a refresh on next access:

```ts
const tenant = this.bridge.fromJwt(jwt);
tenant.invalidate();           // drops the cached snapshot
const fresh = await tenant.subscription;
```

Normally you don't call this — the 30s TTL keeps state fresh. Backend code should react to billing changes via Bridge **webhooks** (event-driven), not by polling.

## Declarative vs programmatic — which to use

- Reach for **`plans` on a route rule** when an entire path is tier-gated and you can name the allowed plans up front.
- Reach for **`entitlements.can(key)`** when the gate is a named capability (not a plan slug), when the same capability is hit from several routes or a queue/cron worker, or when you want a precise 403 message. Entitlement keys are stable across plan renames; plan slugs are not.

## Checklist

- [ ] `list_plans` / `bridge plan list` returns at least one plan (plans configured via the frontend/master billing flow)
- [ ] Stripe is connected on the app (`bridge stripe status`) — no MCP tool exists for connecting it; that's a human step
- [ ] No checkout / paywall / Stripe client code added to the backend — purchasing stays in the frontend + bridge-api
- [ ] Tier-gated paths use `plans: [...]` on the route rule (with a `privilege`)
- [ ] Capability gates use `BridgeService.fromJwt(jwt).entitlements.can(key)` and fail closed
- [ ] JWT is stripped of the `Bearer ` prefix before `fromJwt`
- [ ] `bridge.tenant(tenantId)` is NOT used (not yet wired)
- [ ] Subscription reads use the `subscription` slice (`plan.slug`, `status`, `endsAt`, `gateEngaged`)

## Verify

1. **Build:** the project builds with no TypeScript or import errors.
2. **Plan gate (declarative):** a tenant on `free` calling a `plans: ['pro']` route gets rejected; a `pro` tenant gets 200.
3. **Entitlement gate (programmatic):** a tenant without the `data_export` entitlement gets 403 from the export endpoint; one with it gets 200.
4. **Subscription read:** `GET /billing/status` returns the tenant's current `plan`, `status`, and `endsAt` matching the dashboard.
5. **Fail-closed:** an unknown entitlement key resolves to `false` (the feature is denied), not an error.
