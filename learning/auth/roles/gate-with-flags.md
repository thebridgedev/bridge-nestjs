---
title: Gate features by role or privilege
description: Using a user's role or privileges as feature-flag targeting attributes from a NestJS backend.
sidebar:
  label: NestJS
---

# Gate features by role or privilege

Role and privilege gating with `@RequireRole()` / `@RequirePrivilege()` ([How roles & privileges work](/auth/roles/how-it-works/)) is a hard yes/no check: the request either has the role or it's a `403`. Feature flags are the tool for the softer case: rolling something out to a role gradually, behind a kill switch, or A/B-tested on top of the role check. `@nebulr-group/bridge-nestjs` ships two different flag mechanisms, and they differ in exactly how much role/privilege wiring you have to do yourself.

## Legacy flags (`@RequireFeatureFlag` / `FeatureFlagService`): no wiring needed

The legacy flag path evaluates server-side: `FeatureFlagService` sends the caller's **access token** to Bridge's `cloud-views` API (`/flags/evaluate` or `/flags/bulkEvaluate`), and Bridge itself decodes that token to resolve role, privileges, and tenant for targeting. Same as the frontend SDKs, there's nothing to configure in your NestJS app; a targeting rule written against `user.role` or `privileges` in Control Center (your admin dashboard at app.thebridge.dev) just works the moment you protect a route:

```typescript
import { Controller, Get } from '@nestjs/common';
import { RequireFeatureFlag } from '@nebulr-group/bridge-nestjs';

@Controller('reports')
export class ReportsController {
  @Get('beta')
  @RequireFeatureFlag('beta_reports') // targeting rule can reference user.role / privileges directly
  getBetaReports() { /* … */ }
}
```

Continuing the [enterprise example](/auth/roles/common-setups/): a flag `beta_reports` targeted either at the role directly (`user.role eq "ENTERPRISE_BETA"`) or at the privilege instead (`privileges contains "BETA_REPORTS"`) evaluates correctly with zero code changes, because the evaluation happens on Bridge's side against the same JWT your guard already verified.

## Feature Flags 2.0 (`BridgeFlagsService` / `@RequireFlag`): wiring is explicit

The newer, synchronous flags module (`@nebulr-group/bridge-nestjs/flags`; see [Feature Flags](/feature-flags/feature-flags/)) evaluates **locally, in-process**, against whatever context you hand it. This is the one real backend-vs-frontend difference worth knowing: nothing about role or privilege reaches the evaluator automatically here. A server process isn't "a user," so the SDK never assumes an identity, and it never reaches into `req.bridgeUser` on its own. You either pass identity per call, or you register an attribute provider that does the reading for you.

**Per-call identity, no role targeting:**

```typescript
import { Injectable } from '@nestjs/common';
import { BridgeFlagsService } from '@nebulr-group/bridge-nestjs/flags';

@Injectable()
export class ReportsService {
  constructor(private readonly flags: BridgeFlagsService) {}

  generate(userId: string) {
    return this.flags.flag('beta_reports', false, { identity: userId });
  }
}
```

This buckets rollouts correctly per-user, but a targeting rule written against role or plan won't resolve; the evaluator has no idea what this user's role is unless you tell it.

**Registering role/plan as targeting attributes**: do this once at bootstrap with an `AuthAttributeProvider` (from `@nebulr-group/bridge-auth-core`) that reads your already-verified JWT claims:

```typescript
import { AuthAttributeProvider } from '@nebulr-group/bridge-auth-core';

// once at bootstrap
this.flags.bridge.registerAttributeProvider(
  new AuthAttributeProvider({ getClaims: () => getCurrentClaims() }),
);
```

Once registered, a rule against `bridge:user.role` or `bridge:tenant.plan` resolves the same way it would if it had been decoded automatically. The difference from the frontend (and from the legacy flag path above) is that here *you* wired the provider in, rather than it being implicit. This also means it's on you to make sure `getClaims()` reads from a verified source (`req.bridgeUser`/`req.bridgeApiToken`, set by `BridgeAuthGuard`) and never from anything client-supplied: the same "never trust client-sent role/plan attributes" rule called out in [Feature Flags](/feature-flags/feature-flags/#bridge-managed-attributes) applies here.

**Gating a whole route on a flag**, independent of whether the flag's rule references role at all:

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { RequireFlag, BridgeFlagGuard } from '@nebulr-group/bridge-nestjs/flags';

@Controller('reports')
@UseGuards(BridgeFlagGuard)
export class ReportsController {
  @Get('beta')
  @RequireFlag('beta_reports')
  getBetaReports() { /* … */ }
}
```

`BridgeFlagGuard` doesn't verify identity itself; pair it with `BridgeAuthGuard` (or your own auth) so `req.bridgeUser`/`req.bridgeApiToken` is populated first, the same requirement as the attribute provider above.

## Which one to reach for

- Already using `@RequireFeatureFlag` / route-rule privileges and just need a role-targeted rollout? Nothing to change: write the Control Center rule against `user.role` or `privileges` and it evaluates automatically.
- Building new flag-gated code, need synchronous evaluation with no network round-trip per check, or need non-boolean flag values? Use `BridgeFlagsService` / `@RequireFlag`, and remember to register the attribute provider if any of your targeting rules need role or plan.
