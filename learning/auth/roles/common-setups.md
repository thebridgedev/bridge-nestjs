---
title: Common role setups
description: A few role/privilege patterns that cover most apps, enforced from your NestJS backend.
sidebar:
  label: NestJS
---

# Common role setups

A few patterns that cover most apps, built from privileges you define once (see [Define roles & privileges](/auth/roles/define-roles/)) and enforce from your NestJS backend via `@RequireRole()`, `@RequirePrivilege()`, or route rules.

## Regular user, admin, and read-only

| Role | Key | Privileges | Use case |
|------|-----|------------|----------|
| Member | `MEMBER` | `AUTHENTICATED`, `USER_READ`, `TENANT_READ` | Everyday user — sees their own data and the workspace, can't manage other users or workspace settings |
| Admin | `ADMIN` | `AUTHENTICATED`, `USER_READ`, `USER_WRITE`, `TENANT_READ` | Can manage team members; workspace-level settings (billing, plan) stay with `OWNER` |
| Viewer | `VIEWER` | `AUTHENTICATED`, `USER_READ` | Read-only — can sign in and look around, can't create or edit anything |

`ADMIN` ships with exactly this privilege set by default. `MEMBER` and `VIEWER` are yours to create:

```bash
bridge role create --name Member --key MEMBER --privileges AUTHENTICATED,USER_READ,TENANT_READ

bridge role create --name Viewer --key VIEWER --privileges AUTHENTICATED,USER_READ
```

Enforcing the three from a controller — `@RequireRole()` checks the *role* on a signed-in user's JWT (`user.role`), which is the right tool for gating whole sections of your app by which of these three someone holds:

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, RequireRole, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('team')
@UseGuards(BridgeAuthGuard)
export class TeamController {
  @Get()
  list(@CurrentUser() user: BridgeUser) {
    // MEMBER, ADMIN, and VIEWER can all reach this route —
    // no @RequireRole means any authenticated role passes.
    return { requestedBy: user.email };
  }

  @Get('manage')
  @RequireRole('ADMIN')
  manage(@CurrentUser() user: BridgeUser) {
    return { message: 'Team management', by: user.email };
  }
}
```

If you'd rather gate by what the role *grants* than by its name, use route-rule `privilege` instead — this reads `user.privileges`, so `MEMBER`, `ADMIN`, and any future role that happens to include `USER_WRITE` all pass without you having to list every role key:

```typescript
BridgeModule.forRoot({
  appId: 'YOUR_APP_ID',
  guard: {
    global: true,
    rules: [
      { path: '/team/manage', privilege: 'USER_WRITE' },
    ],
  },
})
```

See [How roles & privileges work](/auth/roles/how-it-works/) for exactly when to reach for `@RequireRole()` vs. `privilege`.

## A bespoke role for one client

Say an enterprise client is paying for early access to a reporting feature nobody else has. Create a privilege for it in Control Center — `BETA_REPORTS` — then a role that bundles it in with the rest of what that user needs:

```bash
bridge role create --name "Enterprise Beta" --key ENTERPRISE_BETA \
  --privileges AUTHENTICATED,USER_READ,TENANT_READ,BETA_REPORTS
```

Assign it to that client's users:

```bash
bridge user invite --email user@enterprise-client.com --role ENTERPRISE_BETA --tenant-id <theirTenantId>
```

The privilege alone doesn't gate anything in your API by itself — you still decide what `BETA_REPORTS` protects. Two ways to wire it up, depending on how the rest of the endpoint is already structured:

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, RequireRole, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('reports')
@UseGuards(BridgeAuthGuard)
export class ReportsController {
  // Option 1 — gate on the role directly. Simple, but only works while
  // ENTERPRISE_BETA is the only role that should see this.
  @Get('beta')
  @RequireRole('ENTERPRISE_BETA')
  getBetaReports(@CurrentUser() user: BridgeUser) {
    return { reports: [], forTenant: user.tenantId };
  }
}
```

```typescript
// Option 2 — gate on the privilege via a route rule. Scales better once a
// second role (or a future plan tier) also needs BETA_REPORTS — grant them
// the privilege instead of hard-coding a second role name into the check.
BridgeModule.forRoot({
  appId: 'YOUR_APP_ID',
  guard: {
    global: true,
    rules: [
      { path: '/reports/beta', privilege: 'BETA_REPORTS' },
    ],
  },
})
```

Keep in mind route-rule `privilege` only applies when the caller presents a **user JWT** — see [How roles & privileges work](/auth/roles/how-it-works/) for the user-JWT-vs-API-token split. If this same report endpoint should also be reachable by an API token (a script pulling reports on the client's behalf), pair it with `@RequirePrivilege('BETA_REPORTS')` too, which is checked independently against the API token's own privilege list. If the feature should also be reflected in a feature-flag-driven UI, see [Gate features by role or privilege](/auth/roles/gate-with-flags/).
