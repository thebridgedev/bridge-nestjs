---
title: Common role setups
description: A few role/privilege patterns that cover most apps, enforced from your NestJS backend.
sidebar:
  label: NestJS
---

# Common role setups

A few patterns that cover most apps, built from privileges you define once (see [Define roles & privileges](/auth/roles/define-roles/)) and enforce from your NestJS backend with a flag ruled on a privilege (`@RequireFeatureFlag()` or a route rule's `featureFlag`), plus `@RequirePrivilege()` for API tokens.

## Regular user, admin, and read-only

| Role | Key | Privileges | Use case |
|------|-----|------------|----------|
| Member | `MEMBER` | `AUTHENTICATED`, `USER_READ`, `TENANT_READ` | Everyday user: sees their own data and the workspace, can't manage other users or workspace settings |
| Admin | `ADMIN` | `AUTHENTICATED`, `USER_READ`, `USER_WRITE`, `TENANT_READ` | Can manage team members; workspace-level settings (billing, plan) stay with `OWNER` |
| Viewer | `VIEWER` | `AUTHENTICATED`, `USER_READ` | Read-only: can sign in and look around, can't create or edit anything |

`ADMIN` ships with exactly this privilege set in the default setup; read the app's real roles with `bridge role list` (or `list_roles`) before writing a rule. `MEMBER` and `VIEWER` are yours to add:

```bash
bridge role create --name Member --key MEMBER --privileges AUTHENTICATED,USER_READ,TENANT_READ

bridge role create --name Viewer --key VIEWER --privileges AUTHENTICATED,USER_READ
```

Enforcing the three from a controller: gate by what the role *grants*, not by its name. A flag `manage-team` ruled `privileges contains "USER_WRITE"` lets `ADMIN`, `OWNER` and any future role that includes `USER_WRITE` through, without listing role keys:

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, RequireFeatureFlag, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('team')
@UseGuards(BridgeAuthGuard)
export class TeamController {
  @Get()
  list(@CurrentUser() user: BridgeUser) {
    // MEMBER, ADMIN and VIEWER can all reach this route: no flag on it.
    return { requestedBy: user.email };
  }

  @Get('manage')
  @RequireFeatureFlag('manage-team') // rule: privileges contains "USER_WRITE"
  manage(@CurrentUser() user: BridgeUser) {
    return { message: 'Team management', by: user.email };
  }
}
```

The same flag works as a route rule: `{ path: '/team/manage', privilege: 'AUTHENTICATED', featureFlag: 'manage-team' }`. Write a role rule (`user.role eq "ADMIN"`) only when you mean the role itself. See [How roles & privileges work](/auth/roles/how-it-works/).

## A bespoke role for one client

Say an enterprise client is paying for early access to a reporting feature nobody else has. Create a privilege for it in Control Center (your admin dashboard at app.thebridge.dev), `BETA_REPORTS`, then a role that bundles it in with the rest of what that user needs:

```bash
bridge role create --name "Enterprise Beta" --key ENTERPRISE_BETA \
  --privileges AUTHENTICATED,USER_READ,TENANT_READ,BETA_REPORTS
```

Assign it to that client's users:

```bash
bridge user invite --email user@enterprise-client.com --role ENTERPRISE_BETA --tenant-id <theirTenantId>
```

The privilege alone doesn't gate anything in your API by itself; you still decide what `BETA_REPORTS` protects. Make it a flag, `beta-reports`, ruled `privileges contains "BETA_REPORTS"`. Once a second role (or a plan that sells the feature) also needs it, you grant the privilege or widen the rule, and the code does not change:

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, RequireFeatureFlag, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('reports')
@UseGuards(BridgeAuthGuard)
export class ReportsController {
  @Get('beta')
  @RequireFeatureFlag('beta-reports') // rule: privileges contains "BETA_REPORTS"
  getBetaReports(@CurrentUser() user: BridgeUser) {
    return { reports: [], forTenant: user.tenantId };
  }
}
```

A flag is evaluated for a signed-in person (user JWT). If this same report endpoint should also be reachable by an API token (a script pulling reports on the client's behalf), add `@RequirePrivilege('BETA_REPORTS')` too, which is checked against the API token's own scope (API tokens only). The same flag drives the UI; see [Gate features by role or privilege](/auth/roles/gate-with-flags/).
