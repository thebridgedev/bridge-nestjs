# Bridge NestJS 1.0 — Plan limits, plan features and the workspace's plan

You are making a NestJS API respect what each workspace's plan allows, with `@nebulr-group/bridge-nestjs` 1.0. The server enforces: anyone can call the API directly, so the limit and the gate live on the handler. The browser shows or hides (the frontend plugin's plan page, `<QuotaGate>`, the upgrade dialog on a `402`), and it reads the same decision the server makes.

## The one rule for app code

**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains "users:write"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.

Two things are not gates and are not flags: **numbers** are plan limits (`<QuotaGate>` in the browser, `@RequireQuota` on the backend), and **permission on one specific record** stays in app code ("only the author edits their post").

Before calling the work done, run `npx @nebulr-group/bridge-cli@alpha check gates` in the project. It lists every direct role, privilege, plan or plan-feature check with the flag to use instead. Fix each one.

In NestJS, an endpoint is `@RequireFlag('…')` on the handler (or a route rule with `featureFlag`).

## What billing means on the backend

| You want | On the backend |
|---|---|
| At most N of something per workspace | `@RequireQuota('metric', { current })` on the handler that creates it, `@SyncQuota` on the one that deletes it |
| A yes/no the plan sells (analytics, exports) | A flag ruled on the plan feature, `@RequireFlag('…')` |
| Count usage that is billed or limited per period | `@RequireQuota('metric')` (a counter), or `@Meter('metric')` when nothing refuses |
| Show the workspace's plan, or keep your own copy | `BridgeManagementService` (`workspace.billing.get()`) and the `subscription.*` webhooks |
| Checkout, plan picker, Stripe redirect | **Not here.** The frontend plugin (bridge-svelte 1.0: `BridgeBillingRoutes`) and Bridge handle it. Add no payments code to the backend. |

`bridge guide mechanisms` (or `get_integration_guide topic=mechanisms`) is the one-page model of limits, counters and gauges and the upgrade dialog.

## Prerequisites

1. The module is registered (integration guide) with `BRIDGE_APP_KEY` set: holding and counting a limit needs the app key, with the privilege `billing.usage:write` (`bridge key create --name "api server" --privilege billing.usage:write`).
2. The routes run behind the guard: a limit belongs to the caller's workspace, from the verified token. A `@Public()` route has no workspace and is refused `401`.

## Configure plans and limits

Plans, prices, trials and limits are the developer's product decisions: ask, then configure. Over MCP: `apply_plan` (one call per plan), `set_plan_quota`, `set_plan_features`, `list_plan_quotas`. From a terminal (CLI 1.0):

```bash
bridge metric set tickets --kind gauge --name Tickets     # a level: deleting one frees room
bridge metric set exports --kind counter --name Exports   # happens; adds up each period
bridge plan create free --name Free --no-trial --limit tickets=3 --limit exports=10
bridge plan create pro --name Pro --price "29 USD/month" --price "290 USD/year" --trial-days 14 --feature analytics --limit tickets=unlimited --limit exports=1000
bridge plan limit set free tickets=5
bridge plan feature add pro analytics
bridge plan list
```

A usage price (`--usage-price "api.calls 0.002 USD/month included 10000"`) makes a metric metered: past what is included it bills per unit and never refuses.

## Plan limits — one decorator on the handler that creates the thing

```ts
import { Controller, Delete, Param, Post } from '@nestjs/common';
import { CurrentActor, RequireFlag, RequireQuota, SyncQuota } from '@nebulr-group/bridge-nestjs';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  // A gauge: tickets exist, so the app counts them.
  @RequireFlag('tickets')
  @RequireQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  @Post()
  create(@CurrentActor('workspaceId') workspaceId: string) {
    return this.tickets.create(workspaceId);
  }

  // Deleting one frees room: after a 2xx the gauge is set to the new count.
  @SyncQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  @Delete(':id')
  remove(@CurrentActor('workspaceId') workspaceId: string, @Param('id') id: string) {
    return this.tickets.remove(workspaceId, id);
  }

  // A counter: an export happens, so Bridge counts it.
  @RequireQuota('exports')
  @Post(':id/export')
  export(@Param('id') id: string) {
    return this.tickets.export(id);
  }
}
```

What happens on a request:

- **Before the handler** Bridge holds one unit of the limit for this request, so two requests never both get the last one.
- **After a 2xx** the unit counts (a gauge is set to your `current`). A handler that throws or answers 4xx/5xx gives the unit back.
- **At the limit** the request is refused before the handler runs:

```json
{ "statusCode": 402, "code": "QUOTA_EXCEEDED", "message": "…", "metric": "tickets", "used": 3, "limit": 3, "fix": "/subscription" }
```

- A workspace locked for payment gets `402 BILLING_GATE_ENGAGED`; when Bridge cannot answer, `503 QUOTA_UNAVAILABLE` (never a yes).
- `fix` is the module's `manageRoute` (default `/subscription`): `BridgeModule.forRoot({ manageRoute: '/account/billing' })`.
- `current` gets the verified workspace (`t.id`, `t.userId`, `t.actor`) and the controller instance.
- **Seats** are a limit counted from membership: Bridge counts the members and pending invites itself.

The frontend reads that `402`: bridge-svelte's `bridgeFetch` opens the upgrade dialog. Count once, where the action happens: never count the same action in the browser and on the server.

### Without decorators

`BridgeQuotaService` for jobs, bulk work or a check in the middle of a handler: `hold(req, metric)` (then `confirm()` or `giveBack()`), `check(req, metric)` (`{ allowed, used, limit, quota }`, refuses nothing), `assertQuota(req, metric)`, `record(req, metric, …)`, `sync(req, metric, current)`.

### The same limit as a flag

A limit can also be a flag whose rule reads `bridge:billing.quota.<metric>.remaining gt 0`, gated with `@RequireFlag` and counted with `@Meter('<metric>')`; it refuses `402 FEATURE_NOT_IN_PLAN`. Use one way per metric, not both. `@RequireQuota` is the one that holds a unit, so two requests cannot take the last one.

## Plan features are flags

A yes/no a plan sells is a flag like every other gate:

```bash
bridge plan feature add pro analytics
bridge flag create analytics --when "bridge:billing.entitlement.analytics eq true"
```

```ts
@RequireFlag('analytics')
@Get('analytics')
analytics() { … }
```

A workspace whose plan lacks it gets `402 FEATURE_NOT_IN_PLAN` with `fix` pointing at the upgrade route. Who may use a feature is the flag; how many is the limit. An endpoint can carry both: `@RequireFlag('exports')` and `@RequireQuota('exports')`.

## Read the workspace's plan on the server

To show the plan, or keep your own copy of it (never to decide access: that is a flag), read the payer through the management client, as the caller:

```ts
import { Controller, Get, Req } from '@nestjs/common';
import { BridgeManagementService } from '@nebulr-group/bridge-nestjs';

@Controller('account')
export class AccountController {
  constructor(private readonly management: BridgeManagementService) {}

  @Get('plan')
  plan(@Req() request: { headers: unknown }) {
    // { plan, status, access, features, limits, usage, periodEnd, trialEnd, cancelAtPeriodEnd, locked, … }
    return this.management.forCaller(request).workspace.billing.get();
  }
}
```

`forCaller(request)` calls Bridge as the signed-in person, with their own privileges (every member may read their workspace's billing). From a job with no person, `this.management.workspace(workspaceId).billing.get()` uses the app key, which then needs `billing:read`. `billing.usage()` gives the usage numbers.

To keep a copy current, receive the `subscription.created`, `subscription.plan_changed`, `subscription.canceled`, `subscription.trial_started`, `subscription.trial_will_end`, `subscription.past_due`, `payment.failed`, `entitlements.changed` and `quota.exhausted` webhooks (team guide: the receiver). Each delivery's `payload.data` carries `workspaceId`; `subscription.plan_changed` carries `fromPlan` and `toPlan`.

## Exceptions: direct plan-feature checks

Only when the developer explicitly asks for no flag: `@RequireEntitlement('analytics')` on a handler or controller (or `BridgeQuotaService.assertEntitlement(req, key)`) refuses with `403 ENTITLEMENT_REQUIRED`. It asks the flag `bridge:billing.entitlement.analytics`, so it still never reads the plan itself.

## Checklist

- [ ] Every handler that creates a limited thing has `@RequireQuota` (with `current` for a gauge); every delete has `@SyncQuota`.
- [ ] Every plan feature is a flag on the plan feature, with `@RequireFlag`.
- [ ] No handler reads the plan to decide what someone may do.
- [ ] No checkout, plan picker or Stripe code on the backend.
- [ ] `BRIDGE_APP_KEY` is set, server side only.

## Verify

Run the terminal checks. If you have a browser tool, run the browser checks too. If you do not, list them for the developer, numbered, and start the summary with a Heads up line saying which checks were not run.

### Terminal checks

1. `npm run build` passes.
2. `bridge plan list`: the plans, prices, trials, features and limits are what the developer asked for.
3. `bridge stripe status`: payments are connected (in test mode while developing).
4. `bridge flag get <key>` for each plan-feature flag: the rule names `bridge:billing.entitlement.<feature>`.
5. Call the limited handler at the limit with a signed-in person's token (`curl -i -X POST -H "Authorization: Bearer <token>" http://localhost:3000/tickets`, once more than the plan allows): every call under the limit answers `2xx`, the next answers `402` with `"code": "QUOTA_EXCEEDED"`, `metric`, `used`, `limit` and `fix`. The same call with no token answers `401`.
6. `npx @nebulr-group/bridge-cli@alpha check gates` lists nothing.

### Browser checks

1. The frontend's plan page shows each plan, with its prices.
2. Choosing a paid plan opens Stripe Checkout; a test payment returns to the app on the new plan, and a cancelled one returns unchanged.
3. Creating one more than the plan allows opens the upgrade dialog from the `402`.
4. After upgrading, the same action succeeds.

When a browser check was not run, the summary starts with "Heads up: not verified in a browser" and lists which, instead of the success message.
