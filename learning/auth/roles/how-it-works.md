---
title: How roles & privileges work
description: The role/privilege model, and how it's enforced by BridgeAuthGuard.
sidebar:
  label: NestJS
---

# How roles & privileges work

A **role** is a named set of **privileges** — scoped permission keys like `USER_READ` or `TENANT_WRITE`. Every user is assigned exactly one role per tenant; the role determines what that user can do in that workspace.

Roles are fully custom to your app — you're not stuck with a fixed enum. Every app starts with:

- **`OWNER`** — required, protected, granted automatically. See [The owner role](/auth/roles/owner-role/).
- **`ADMIN`** — created by default but just a normal role; rename it, change its privileges, or delete it.

From there you can define as many roles as you need — see [Common role setups](/auth/roles/common-setups/) for a worked example.

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

There is no server-side lookup involved — the guard never queries a roles database. Whatever role/privileges are embedded in the token *are* the role/privileges for that request. See [How the token is kept current](/auth/user-token/object-updates/) for what that implies when a role changes mid-session.

## Two separate enforcement mechanisms

This is the part that trips people up: **role checks and privilege checks are enforced against different credential types.**

| Decorator | Applies to | Bypassed by |
|---|---|---|
| `@RequireRole(role)` | User JWT only — checks `user.role` | API tokens don't carry a `role`, so this decorator has no effect on API-token-only requests |
| `@RequirePrivilege(privilege)` | API token only — checks `req.bridgeApiToken.privileges` | User JWTs bypass this check entirely (backward-compatibility: existing endpoints that added `@RequirePrivilege()` for API-token enforcement don't break user-JWT access) |
| Route-rule `privilege` (e.g. `{ path: '/users/*', privilege: 'USER_READ' }`) | User JWT only — checks `user.privileges` | Only evaluated when a user JWT is present on the request |

In practice: use `@RequireRole()` (or route-rule `privilege`) to gate what a **signed-in person** can do, and `@RequirePrivilege()` to gate what a **token** (script, integration, CI job) can do. See [API tokens](/auth/api-tokens/) for the full API-token auth flow.

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, RequireRole, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('admin')
@UseGuards(BridgeAuthGuard)
@RequireRole('ADMIN') // every route in this controller requires ADMIN
export class AdminController {
  @Get('dashboard')
  getDashboard(@CurrentUser() user: BridgeUser) {
    return { message: 'Admin dashboard', admin: user.email };
  }

  @Get('settings')
  @RequireRole('OWNER') // route-level override — requires OWNER instead of ADMIN
  getSettings(@CurrentUser() user: BridgeUser) {
    return { settings: 'sensitive data' };
  }
}
```

Route-level decorators override controller-level ones — the guard uses Nest's `Reflector.getAllAndOverride`, so the most specific decorator wins. A `403 Forbidden` with `"Role '<role>' required"` is thrown when the check fails.

For anything security-critical, enforce it here — in a guard or decorator on the actual endpoint — never rely on a role check that only exists in a caller's UI.
