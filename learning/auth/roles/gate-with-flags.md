---
title: Gate features by role or privilege
description: Using a user's privileges or role as feature-flag targeting attributes from a NestJS backend.
sidebar:
  label: NestJS
---

# Gate features by role or privilege

Feature flags are the standard way to decide who gets a route, an API endpoint or a feature. A flag's rule changes without a release and applies live when someone's role or plan changes. `@RequirePrivilege()` / `@RequireRole()` ([How roles & privileges work](/auth/roles/how-it-works/)) are still there for a fixed yes/no check that should never change at runtime.

When the rule is about who someone is, prefer a **privilege** rule (`privileges contains "BETA_REPORTS"`) over a **role** rule (`user.role eq "ADMIN"`). A privilege rule keeps working when roles are renamed or reshuffled; which privileges a role has is only "the default setup" and differs per app.

## `@RequireFlag` / `BridgeFlagsService`: nothing to wire

The flags module (`@nebulr-group/bridge-nestjs/flags`; see [Feature Flags](/feature-flags/)) evaluates in-process. On every request `BridgeAuthGuard` verified, `BridgeFlagGuard`, `@Flag(...)` and `BridgeContextInterceptor` fill in the user's `user.role`, `privileges`, `user.id`, `user.email`, `tenant.id` and `tenant.plan` from the verified token, and, with `BridgeModule` loaded, the workspace's `bridge:billing.plan` and `bridge:billing.entitlement.<feature>`. A rule written in Control Center (your admin dashboard at app.thebridge.dev) gives the same answer here as in the browser:

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard } from '@nebulr-group/bridge-nestjs';
import { RequireFlag, BridgeFlagGuard } from '@nebulr-group/bridge-nestjs/flags';

@Controller('reports')
@UseGuards(BridgeAuthGuard, BridgeFlagGuard) // auth first, so the token is verified
export class ReportsController {
  @Get('beta')
  @RequireFlag('beta_reports') // rule: privileges contains "BETA_REPORTS"
  getBetaReports() { /* … */ }
}
```

Continuing the [enterprise example](/auth/roles/common-setups/): a flag `beta_reports` targeted at the privilege (`privileges contains "BETA_REPORTS"`), or at the role (`user.role eq "ENTERPRISE_BETA"`), evaluates correctly with zero code changes.

Only verified values count: the attributes come from the token `BridgeAuthGuard` verified, never from the `x-bridge-context` header or a `role` on `req.user`. See [Target by plan, privilege or role](/feature-flags/targeting/by-plan-or-role/) for the full attribute list.

In a service, pass the request's context along so the rule sees the same attributes:

```typescript
@Get('reports')
list(@Req() req) {
  const beta = this.flags.flag('beta_reports', false, req.bridgeFlagsContext); // set by BridgeContextInterceptor
  // …
}
```

A bare `this.flags.flag('beta_reports', false, { identity: userId })` sees only the identity you pass, so a privilege or role rule won't match it.

## `@RequireFeatureFlag` / `FeatureFlagService`: the older path

`FeatureFlagService` sends the caller's access token to Bridge's API (`/flags/evaluate` or `/flags/bulkEvaluate`) and Bridge evaluates the flag there. It resolves `user.role`, `user.email`, `tenant.id` and `tenant.plan` from the token. It does **not** resolve `privileges` or `bridge:billing.*` yet, so a privilege rule or a plan-feature rule doesn't match on this path:

```typescript
import { Controller, Get } from '@nestjs/common';
import { RequireFeatureFlag } from '@nebulr-group/bridge-nestjs';

@Controller('reports')
export class ReportsController {
  @Get('beta')
  @RequireFeatureFlag('beta_reports') // role rules work here; privilege rules don't yet
  getBetaReports() { /* … */ }
}
```

## Which one to reach for

- New flag-gated code, or any rule on a privilege or a plan feature: `@RequireFlag` / `BridgeFlagsService`. It evaluates in-process with no network round-trip per check and supports non-boolean values.
- Existing `@RequireFeatureFlag` code with role rules keeps working; move it to `@RequireFlag` when a rule needs a privilege or a plan feature.
