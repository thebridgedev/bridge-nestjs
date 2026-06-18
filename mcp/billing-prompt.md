# Bridge NestJS — Billing & Entitlements

You are adding **server-side billing enforcement** to a NestJS application that uses The Bridge.

> **What "billing" means on the backend.** A backend plugin **reads** subscription state and **enforces** entitlements — nothing more. There is no checkout, no paywall, no plan-selector, and no Stripe redirect here. Purchasing lives entirely in the **frontend** Bridge plugin (the plan selector + Stripe Checkout) and in **bridge-api** (Stripe webhooks that sync plan/subscription state). This guide covers two things only: (1) reading the current tenant's subscription, and (2) gating server behavior on the tenant's plan and entitlements. Do not add purchasing, checkout URLs, or Stripe client code to the backend.

Team/workspace management is likewise out of scope — the backend surface is read-only and exposes no team CRUD. Member management is driven from the frontend plugin and bridge-api.

## Prerequisites

1. `@nebulr-group/bridge-nestjs` installed and `BridgeModule.forRoot()` registered (see `integration-prompt.md`).
2. Plans and Stripe are already configured on the Bridge app (done in the frontend/master billing flow). Confirm with `bridge plan list` — at least one plan should exist.
3. Routes are protected — entitlement gating runs on a verified user JWT, so the caller must be authenticated.

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

- [ ] `bridge plan list` returns at least one plan (plans configured via the frontend/master billing flow)
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
