---
title: How roles & privileges work
description: The role/privilege model, and how it's enforced by BridgeAuthGuard.
sidebar:
  label: NestJS
---

# How roles & privileges work

A **role** is a named set of **privileges**: scoped permission keys like `USER_READ` or `TENANT_WRITE`. Every user is assigned exactly one role per workspace (called a *tenant* in the API); the role determines what that user can do in that workspace.

Roles are fully custom to your app; you're not stuck with a fixed enum. Every app starts with:

- **`OWNER`**: required, protected, granted automatically. See [The owner role](/auth/roles/owner-role/).
- **`ADMIN`**: created by default but just a normal role; rename it, change its privileges, or delete it.

From there you can define as many roles as you need. See [Common role setups](/auth/roles/common-setups/) for a worked example, including a bespoke role for a specific client.

## Where role and privileges live

Both travel in the verified JWT, decoded onto the request by `BridgeAuthGuard`:

| Claim | Ends up on | Type |
|---|---|---|
| `role` | `user.role` (via `@CurrentUser()`) | `string \| undefined` |
| `privileges` | `user.privileges` (via `@CurrentUser()`) | `string[] \| undefined` |
| `privileges` (API token) | `req.bridgeApiToken.privileges` | `string[]` |

```typescript
import { Controller, Get } from '@nestjs/common';
import { CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('users')
export class UsersController {
  @Get('me')
  getProfile(@CurrentUser() user: BridgeUser) {
    return { role: user.role, privileges: user.privileges };
  }
}
```

There is no server-side lookup involved; the guard never queries a roles database. Whatever role/privileges are embedded in the token *are* the role/privileges for that request. See [How the token is kept current](/auth/user-token/object-updates/) for what that implies when a role changes mid-session.

## How roles and privileges are enforced

What a role can do is only true **in the default setup**; every app can change it. Read the app's real roles and privileges (`list_roles` / `bridge role list`) before writing a rule.

Two mechanisms, for two kinds of caller:

| Mechanism | Applies to | What decides |
|---|---|---|
| `@RequireFeatureFlag(key)` (or a route rule's `featureFlag`) | A signed-in person (user JWT) | The flag's rule, e.g. `privileges contains "USER_WRITE"` |
| `@RequirePrivilege(privilege)` | API tokens only; checks `req.bridgeApiToken.privileges` | The token's scope. It is not a gate on a person, so a user JWT is not checked against it |

In practice: gate what a **signed-in person** can do with a flag ruled on a privilege, and scope what a **token** (script, integration, CI job) can do with `@RequirePrivilege()`. Prefer a privilege rule over a role rule; write `user.role eq "ADMIN"` only when you mean the role itself. `contains` is exact membership. See [Gate with feature flags](/auth/roles/gate-with-flags/) and [API tokens](/auth/api-tokens/).

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, RequireFeatureFlag, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('admin')
@UseGuards(BridgeAuthGuard)
@RequireFeatureFlag('admin-area') // rule: privileges contains "USER_WRITE"
export class AdminController {
  @Get('dashboard')
  getDashboard(@CurrentUser() user: BridgeUser) {
    return { message: 'Admin dashboard', admin: user.email };
  }

  @Get('settings')
  @RequireFeatureFlag('admin-settings') // rule: privileges contains "TENANT_WRITE"
  getSettings(@CurrentUser() user: BridgeUser) {
    return { settings: 'sensitive data' };
  }
}
```

Route-level decorators override controller-level ones; the guard uses Nest's `Reflector.getAllAndOverride`, so the most specific decorator wins. A refused request gets 403 `FEATURE_NOT_PERMITTED` (or `FEATURE_OFF`) naming the flag.

For anything that must be enforced (not just hidden in a caller's UI), put the flag on the actual endpoint too; the same rule answers the same way in the browser and the backend.
