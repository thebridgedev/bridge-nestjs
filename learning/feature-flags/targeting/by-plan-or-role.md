# Target by plan, privilege or role

This is one of the biggest advantages of building flags on Bridge instead of
in isolation: Bridge already knows who's signed in, what they are allowed to
do, and what their workspace (called a *tenant* in the API) is paying for. A
rule on any of those gives the same answer in your NestJS backend as in the
browser, with **no code from you**. `BridgeFlagGuard`, `@Flag(...)` and
`BridgeContextInterceptor` fill the attributes in on every request that
`BridgeAuthGuard` verified.

Feature flags are the standard way to control a route, an API endpoint or a
feature. Use one rule, written once in Control Center (your admin dashboard at
app.thebridge.dev), and both sides follow it.

## What a rule can target

From the signed-in user's token, verified by `BridgeAuthGuard`:

| Attribute | Comes from | Example values |
|---|---|---|
| `user.id` | the token's `sub` | the signed-in user's id |
| `user.role` | the token's `role` | `MEMBER`, `ADMIN`, `OWNER` in the default setup |
| `user.email` | the token's `email` | `jane@acme.com` |
| `tenant.id` | the token's `tid` | the current workspace's id |
| `tenant.plan` | the token's `plan` | the workspace's plan when the token was issued |
| `privileges` | the token's `privileges` | the user's privilege list, e.g. `USER_READ` |

From the workspace's billing, read from Bridge and cached per workspace:

| Attribute | Example values |
|---|---|
| `bridge:billing.plan` | the workspace's current plan, e.g. `pro` |
| `bridge:billing.subscription.status` | e.g. `active`, `trial` |
| `bridge:billing.trial` | `true` while the workspace is on a trial |
| `bridge:billing.entitlement.<feature>` | `true` when the plan includes the feature |

Auth attributes aren't prefixed and billing attributes are under
`bridge:billing.`, exactly as in the browser SDKs. Both sides use the same
mapping from `@nebulr-group/bridge-auth-core`, so a name that works in one
works in the other.

`bridge:billing.quota.*` (usage against a plan limit) is available in the
browser but not yet on the server: the snapshot a server reads doesn't carry
quotas. Use [plan limits](/plan-limits/) for numbers on the backend; flags are
the wrong tool for them anyway.

## Which attribute to write the rule on

- **A feature a plan sells** → `bridge:billing.entitlement.<feature>`. Include
  the feature on the plan, then point the flag's rule at it. The plan is where
  the customer sees what they are buying, so changing what Pro includes stays
  one edit in one place. See [Lock features to a plan](/billing/limits/lock-features/).
- **Who someone is** → prefer a privilege rule (`privileges contains
  "REPORTS_BETA"`) over a role rule (`user.role eq "ADMIN"`). A privilege rule
  survives renamed or reshuffled roles; roles and what they can do differ per
  app, so check the app's real roles before writing a role rule.
- **The plan name itself** → `bridge:billing.plan`. It follows the workspace's
  subscription within seconds. `tenant.plan` is the plan recorded in the
  user's token and changes when the token is renewed.

## Example: gate a route on a plan feature

Rule: *on for users matching `bridge:billing.entitlement.export eq true`*.

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard } from '@nebulr-group/bridge-nestjs';
import { RequireFlag, BridgeFlagGuard } from '@nebulr-group/bridge-nestjs/flags';

@Controller('reports')
@UseGuards(BridgeAuthGuard, BridgeFlagGuard) // auth first, so the token is verified
export class ReportsController {
  @Get('export')
  @RequireFlag('export_reports')
  exportReports() { /* … */ }
}
```

## Example: gate a route on a privilege

Rule: *on for users matching `privileges contains "BILLING_SETTINGS"`*. Same
controller shape, `@RequireFlag('billing_settings')` on the route. Nothing
else changes.

## In a service or handler

`BridgeContextInterceptor` puts the resolved context on the request as
`req.bridgeFlagsContext`; pass it to `flag()`:

```typescript
@Get('home')
home(@Req() req) {
  const showNew = this.flags.flag('new_home', false, req.bridgeFlagsContext);
  // …
}
```

Outside the interceptor, `resolvedFlagContext(req, bridgeService)` (from
`@nebulr-group/bridge-nestjs/flags`) builds the same context. A bare
`this.flags.flag(key, default, { identity })` sees only the identity you pass.

## How freshness works

The billing attributes come from the same workspace snapshot the plan-limit
and entitlement checks read, cached for 30 seconds and shared by every user of
the workspace. The cache is dropped early when a user of the workspace shows
up with a newer token, which Bridge issues when their plan, role or
privileges change. If Bridge can't be reached, rules on `bridge:billing.*`
see no value until it answers; rules on the token's attributes keep working.

With `BridgeFlagsModule` on its own (no `BridgeModule`), the token attributes
are still filled in; the billing attributes need `BridgeModule`.

## Only verified values count

Every attribute above comes from the token `BridgeAuthGuard` verified, or
from Bridge itself. Nothing a client sends is used: not the `x-bridge-context`
header, not a `role` or `plan` on `req.user`, not a `bridgeFlagsContext`
property a middleware set. Your own per-call `attributes` still win on a key
collision, so don't pass client input there either.

## The older `@RequireFeatureFlag` path

The main `@nebulr-group/bridge-nestjs` entry point also ships
`@RequireFeatureFlag` / `FeatureFlagService`, which asks Bridge's API to
evaluate each flag from the caller's access token. It resolves `user.role`,
`user.email`, `tenant.id` and `tenant.plan`, but not `privileges` or
`bridge:billing.*` yet. For new code, use `@RequireFlag`. See
[Gate features by role or privilege](/auth/roles/gate-with-flags/).
