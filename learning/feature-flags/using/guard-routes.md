# Guard routes

Sometimes a flag decides not *what* a handler does but *whether it runs at
all*: an endpoint that should only exist while a feature is on. Gate it
declaratively with `BridgeFlagGuard` + `@RequireFlag`, so a request is
rejected before your handler is ever entered.

## Gate a handler with @RequireFlag

Apply `BridgeFlagGuard` (at the controller or route level) and mark the
handlers that require a flag:

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { RequireFlag, BridgeFlagGuard } from '@nebulr-group/bridge-nestjs/flags';

@Controller('exports')
@UseGuards(BridgeFlagGuard)
export class ExportsController {
  @Get()
  @RequireFlag('exports_enabled')
  list() {
    // only reachable when exports_enabled is on
  }
}
```

When the flag is off, the guard refuses and your handler never runs. The
answer says why, so the frontend can react to it:

| Why the flag is off | Status | `code` | `fix` |
|---|---|---|---|
| The workspace's plan doesn't include it: an upgrade alone would turn it on | `402` | `FEATURE_NOT_IN_PLAN` | where to upgrade (`manageRoute`, default `/subscription`) |
| The person's role or privileges keep it off | `403` | `FEATURE_NOT_PERMITTED` | ask a workspace admin |
| Switched off, another condition, or outside the rollout | `403` | `FEATURE_OFF` | none |

```json
{ "statusCode": 402, "code": "FEATURE_NOT_IN_PLAN", "flag": "exports_enabled",
  "feature": "exports", "reason": "plan", "fix": "/subscription",
  "message": "Your plan does not include 'exports'. Upgrade to use it." }
```

`feature` is there when the flag's rule targets a plan feature
(`bridge:billing.entitlement.<feature>`). The 403s are still
`ForbiddenException`s and keep the old `message`
(`Feature flag 'exports_enabled' is not enabled`). The Svelte plugin opens its
upgrade dialog on a `402 FEATURE_NOT_IN_PLAN`, as it does for a plan limit.
A handler with no `@RequireFlag` passes the guard untouched.

## Gate on a specific value

`@RequireFlag(key, defaultValue = false, options?)`. For a non-boolean flag,
use `options.equals` to require a particular value:

```typescript
@Get('beta')
@RequireFlag('export_mode', 'v1', { equals: 'v2' })
betaExport() {
  // only reachable when export_mode evaluates to 'v2'
}
```

The second argument is the default the guard evaluates with when the flag is
unconfigured or Bridge is unreachable.

## Kill switches: skip instead of reject

`options.optional: true` makes the guard *skip* the handler instead of
refusing with the flag-specific `402` / `403`. This is the pattern for a kill switch that
should quietly disable a route rather than surface a flag error:

```typescript
@Get('legacy-report')
@RequireFlag('legacy_report_enabled', false, { optional: true })
legacyReport() {
  // guarded off silently when the flag is off
}
```

## The guard does not verify identity

`BridgeFlagGuard` only reads the flag; it never authenticates the caller. If
the flag has a percentage rollout or targets a user attribute, the request
needs an identity to bucket against. Compose the flag guard with
`BridgeAuthGuard` (or your own auth) so `req.bridgeUser` (or `req.user`) is
populated first: the guard evaluates for that verified caller, and a request
without one is evaluated anonymously. Nothing the client sends, including the
`x-bridge-context` header, changes the guard's decision. See
[Per-request context](/feature-flags/using/backend/) and
[Gate features with flags](/auth/roles/gate-with-flags/).

## Flag values as handler parameters: @Flag

When you want the flag *value* in the handler rather than a hard gate, the
`@Flag` param decorator injects it directly:

```typescript
import { Controller, Get } from '@nestjs/common';
import { Flag } from '@nebulr-group/bridge-nestjs/flags';

@Controller('home')
export class HomeController {
  @Get()
  home(@Flag({ key: 'show_new_home', defaultValue: false }) showNew: boolean) {
    return showNew ? this.newHome() : this.classicHome();
  }
}
```

`@Flag` reads the same per-request context (`req.bridgeFlagsContext`) that the
guard uses, so it buckets against the same identity. For a typed, reusable
param, wrap it with `useFlagParam<T>(key, defaultValue)`.
