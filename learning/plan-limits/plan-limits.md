# Plan limits and entitlements

A plan limit is one decorator on the handler that creates the thing. It holds one unit of the limit before the handler runs and counts it after the handler succeeds, so a POST increments the limit and there is nothing else to wire: no usage call after the insert, no counter table, no quota endpoint for the frontend.

The limit lives on your backend because anyone can call your API directly. The frontend only shows the decision: Bridge's frontend plugins open an upgrade dialog on the `402` this page describes, with no page code. The server enforces; the browser shows or hides.

## The one rule for app code

**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains "users:write"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.

Two things are not gates and are not flags: **numbers** are plan limits (`<QuotaGate>` in the browser, `@RequireQuota` on the backend), and **permission on one specific record** stays in app code ("only the author edits their post").

Before calling the work done, run `npx @nebulr-group/bridge-cli check gates` in the project. It lists every direct role, privilege, plan or plan-feature check with the flag to use instead. Fix each one.

In NestJS, an endpoint is `@RequireFeatureFlag('…')` on the handler (or a route rule with `featureFlag`).

## Counter or gauge

**If deleting it frees room, it's a gauge and your app counts it; if it happened, it's a counter and Bridge counts it.**

| | Counter | Gauge |
|---|---|---|
| Examples | exports, API calls, AI completions | tickets, projects, stored files, seats |
| Who counts | Bridge, one event per successful request | Your app, from its own data |
| Resets | each billing period | never |
| Metric | `bridge metric set exports --kind counter` | `bridge metric set tickets --kind gauge` |
| Limit | `bridge plan limit set <plan> exports=100` | `bridge plan limit set <plan> tickets=5` |
| Decorator | `@RequireQuota('exports')` | `@RequireQuota('tickets', { current })` on create, `@SyncQuota('tickets', { current })` on delete |

```ts
import { Controller, Delete, Param, Post } from '@nestjs/common';
import {
  CurrentActor,
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
  create(@CurrentActor('workspaceId') workspaceId: string) {
    return this.tickets.create(workspaceId);
  }

  // Deleting one frees room: after a 2xx the gauge is set to the new count.
  @Delete(':id')
  @SyncQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  remove(@CurrentActor('workspaceId') workspaceId: string, @Param('id') id: string) {
    return this.tickets.remove(workspaceId, id);
  }

  // A counter: exports happen, so Bridge counts them.
  @Post(':id/export')
  @RequireQuota('exports')
  export(@Param('id') id: string) {
    return this.tickets.export(id);
  }
}
```

`current` receives a `QuotaTenant` (`t.id` is the verified workspace id, `t.userId` the person, `t.actor` the verified caller) and the controller instance, so it can use the controller's services. After a 2xx the gauge is set to your count, so Bridge's copy heals itself if it ever missed an update. There is no decrement: every create and delete sends the whole count.

**Seats** are a built-in metric, `seats`, counted from membership: set its limit with `bridge plan limit set <plan> seats=5`. Bridge counts the workspace's active members, pending invites included, so the app does not pass `current` for it.

## What happens on a request

- **Before the handler:** Bridge holds one unit of the limit for this request (`402` when none is left). Two requests never get the last unit. A `metered` quota never refuses: past its allowance it bills per unit. A metric the plan has no quota for is unlimited.
- **After the handler:** on a **2xx** response the unit counts, and a gauge is set to your count. A handler that throws or answers 4xx/5xx gives the unit back and records nothing. A handler that runs longer than 120 seconds loses its hold: the unit is then counted from a usage report instead, once, it is logged, and the response is unaffected.
- **Retries:** every request holds its own unit, so a retried request that succeeds counts again. The `Idempotency-Key` header is not used to count.
- **Identity:** the workspace comes from the verified caller only. The route must be behind `BridgeAuthGuard` (or the global guard); a `@Public()` route has no workspace and gets `401`.
- **Fail-closed:** if Bridge cannot answer, the request is refused with `503` (`QUOTA_UNAVAILABLE`).
- **Counting needs the module's `appKey`.**

The refusal your frontend reads:

```json
{ "statusCode": 402, "code": "QUOTA_EXCEEDED", "message": "Your plan allows 5 tickets; 5 are in use.",
  "metric": "tickets", "used": 5, "limit": 5, "fix": "/subscription" }
```

`fix` is the app's subscription page; change it with `BridgeModule.forRoot({ manageRoute: '/account/billing' })`.

A workspace locked for payment is refused as it was before: `402 { "code": "BILLING_GATE_ENGAGED", "reason": "billing_locked", "billing": { "status": "past_due", "gateEngaged": true, "recoveryUrl": "/subscription" } }`. Reads are never refused for this reason.

## Plan features — a flag

A yes/no a plan sells (analytics, PDF export) is not a number, so it is a flag like every other gate:
list the feature on the plans that sell it (`bridge plan feature add pro analytics`), rule the flag
`bridge:billing.entitlement.analytics eq true`, and put `@RequireFeatureFlag('analytics')` on the handler
or controller. A workspace without it gets `402 FEATURE_NOT_IN_PLAN` with the upgrade route in `fix`.

Who may use a feature is the flag; how many is the quota. An endpoint can carry both:
`@RequireFeatureFlag('exports-enabled')` and `@RequireQuota('exports')`.

## Without decorators

`BridgeQuotaService` does the same as plain calls, for bulk jobs, workers or a check in the middle of a handler:

| Call | Does |
|---|---|
| `hold(req, metric, { quantity? })` | Holds a unit and returns it: `confirm()` when the work happened, `giveBack()` when it did not. Refuses with the `402` above |
| `check(req, metric, { current? })` | Decides without holding or refusing: `{ allowed, used, limit, quota }` |
| `assertQuota(req, metric, { current? })` | The same check, refusing with the `402` above. Holds nothing |
| `record(req, metric, { current? \| value?, idempotencyKey? })` | One write: a gauge set or a counter event; never throws |
| `sync(req, metric, current)` | Sets the gauge (what `@SyncQuota` does) |

At the lowest level, `BridgeService.count(actor, metric, n)` counts and `BridgeQuotaService` wraps the same calls auth-core's server has: `usage.hold`, `usage.set` and `usage.quota`.

## The same limit as a flag

A limit can also be a flag whose rule reads `bridge:billing.quota.<metric>.limit`, gated with `@RequireFlag` and counted with `@Meter`; it refuses with `402 FEATURE_NOT_IN_PLAN`. `@RequireQuota` is the one decorator that holds, counts and answers the `QUOTA_EXCEEDED` body your frontend's upgrade dialog reads, so use one or the other for a metric, not both.

## Workspaces that cannot write

Separately from your decorators and flags, the guard refuses a signed-in person's writes (any method but `GET`, `HEAD` and `OPTIONS`) while their workspace is suspended or scheduled for deletion (403, `urn:bridge:problem:workspace-not-active`) or locked for payment (402 `BILLING_GATE_ENGAGED`, as above, with the problem `urn:bridge:problem:billing-locked` beside it), and answers 503 while Bridge cannot tell. Reads are never refused for these reasons. There is nothing to add.

## Exceptions: direct plan-feature checks

For the rare case where the developer explicitly asks for no flag: `@RequireEntitlement('analytics')` on a
handler or controller, or `BridgeQuotaService.assertEntitlement(req, key)`, refuses with
`403 { "code": "ENTITLEMENT_REQUIRED", "entitlement": "…", "fix": "/subscription" }`. It asks the flag
`bridge:billing.entitlement.analytics`, so it never reads the plan itself.

## Count once, where the action happens

When the click calls this backend, the handler counts it, with `@RequireQuota` / `@SyncQuota` above, and the frontend only shows the number. Never count the same action in two places: it would be counted twice.
