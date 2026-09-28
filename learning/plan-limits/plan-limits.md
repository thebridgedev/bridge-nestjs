# Plan limits and entitlements

A plan limit is one decorator on the handler that creates the thing. It checks the limit before the handler runs and records the use after it succeeds, so a POST increments the limit and there is nothing else to wire: no usage call after the insert, no counter table, no quota endpoint for the frontend.

The limit lives on your backend because anyone can call your API directly. The frontend only shows the decision: Bridge's frontend plugins open an upgrade dialog on the `402` this page describes, with no page code. The server is authoritative; the client is decorative.

## Counter or gauge

**If deleting it frees room, it's a gauge and your app counts it; if it happened, it's a counter and Bridge counts it.**

| | Counter | Gauge |
|---|---|---|
| Examples | exports, API calls, AI completions | tickets, projects, stored files, seats |
| Who counts | Bridge, one event per successful request | Your app, from its own data |
| Resets | each billing period | never |
| Quota | `bridge plan quota set <plan> --metric exports --limit 100 --policy hard` | the same with `--kind gauge` |
| Decorator | `@RequireQuota('exports')` | `@RequireQuota('tickets', { current })` on create, `@SyncQuota('tickets', { current })` on delete |

```ts
import { Controller, Delete, Param, Post } from '@nestjs/common';
import {
  BridgeTenant,
  CurrentTenant,
  RequireEntitlement,
  RequireQuota,
  SyncQuota,
} from '@nebulr-group/bridge-nestjs';
import { TicketsService } from './tickets.service';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  // A gauge: tickets exist, so the app counts them.
  @Post()
  @RequireQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  create(@CurrentTenant() tenant: BridgeTenant) {
    return this.tickets.create(tenant.id);
  }

  // Deleting one frees room: after a 2xx the gauge is set to the new count.
  @Delete(':id')
  @SyncQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  remove(@CurrentTenant() tenant: BridgeTenant, @Param('id') id: string) {
    return this.tickets.remove(tenant.id, id);
  }

  // A counter: exports happen, so Bridge counts them.
  @Post(':id/export')
  @RequireEntitlement('app_active')
  @RequireQuota('exports')
  export(@Param('id') id: string) {
    return this.tickets.export(id);
  }
}
```

`current` receives the tenant (`t.id` is the verified workspace id; it is a `QuotaTenant`, so leave it unannotated or type it as `QuotaTenant`, not `BridgeTenant`) and the controller instance, so it can use the controller's services. Your count is what the limit is compared against, so Bridge's copy heals itself if it ever missed an update. There is no decrement and no reservation.

**Seats** (`users`) are a gauge Bridge keeps from workspace membership. `@RequireQuota('users')` on an invite handler checks the seat limit and writes nothing.

## What happens on a request

- **Before the handler:** `@RequireEntitlement` is checked first (`403`), then the quota (`402`). A `metered` quota never refuses — past its allowance it bills per unit. A metric the plan has no quota for is unlimited.
- **After the handler:** only on a **2xx** response, exactly one write to Bridge per decorated metric. A handler that throws or answers 4xx/5xx records nothing.
- **Retries:** a counter request with an `Idempotency-Key` header counts once per key for that workspace and metric.
- **Identity:** the workspace comes from the verified token only. The route must be behind `BridgeAuthGuard` (or the global guard); a `@Public()` route has no workspace and gets `401`.
- **Fail-closed:** if Bridge cannot answer the quota or entitlement read, the request is refused with `503`.

The refusal your frontend reads:

```json
{ "statusCode": 402, "code": "QUOTA_EXCEEDED", "message": "Your plan allows 5 tickets; 5 are in use.",
  "metric": "tickets", "used": 5, "limit": 5, "fix": "/subscription" }
```

For an entitlement: `403 { "code": "ENTITLEMENT_REQUIRED", "entitlement": "…", "fix": "/subscription" }`. `fix` is the app's subscription page; change it with `BridgeModule.forRoot({ billing: { manageRoute: '/account/billing' } })`.

## Entitlements

An entitlement is a yes/no a plan grants. There is no separate setting for one:

- **Every hard quota is also an entitlement** of the same name (dots become `_`), true while there is room. So never pair `@RequireEntitlement('exports')` with `@RequireQuota('exports')`: at the cap the entitlement answers `403` before the quota can answer the `402` the frontend upsells from.
- **A plan feature is a hard quota nothing counts:** `bridge plan quota set pro --metric analytics --limit 1 --policy hard` makes `analytics` true on `pro`; a plan without it answers false. Gate it with `@RequireEntitlement('analytics')` on a handler or a whole controller.
- **`app_active`** is always present: true while the subscription is active, trialing, past due or cancelling at period end.

## Without decorators

`BridgeQuotaService` does the same as plain calls, for bulk jobs, workers or a check in the middle of a handler:

| Call | Does |
|---|---|
| `check(req, metric, { current? })` | Decides without refusing: `{ allowed, used, limit, quota }` |
| `assertQuota(req, metric, { current? })` | Refuses with the `402` above |
| `record(req, metric, { current? \| value?, idempotencyKey? })` | One write: a gauge set or a counter event; never throws |
| `sync(req, metric, current)` | Sets the gauge (what `@SyncQuota` does) |
| `assertEntitlement(req, key)` | Refuses with the `403` above |

At the lowest level, `bridge.fromRequest(req).usage` has `quota(metric)`, `report(metric, n, key)` and `set(metric, count)` — see [BridgeService](../bridge-service/bridge-service.md).

## Count once, where the action happens

When the click calls this backend, the handler counts it — `@RequireQuota` / `@SyncQuota` above — and the frontend only shows the number. When an action never reaches a server (a local-first or mobile app), Bridge's frontend plugins count it themselves (`bridge.usage.report()` / `bridge.usage.set()` in bridge-svelte); that is first-class, and it trusts the browser.

Never both: the same action would be counted twice. Outside production (`NODE_ENV` is not `production`), every response from a counting endpoint — a 2xx or the `402` refusal — carries `X-Bridge-Usage-Counted: <metric>` (and adds it to `Access-Control-Expose-Headers`), and bridge-svelte warns once in the browser console, in development, when the page also reports that metric. In production the header is never sent.
