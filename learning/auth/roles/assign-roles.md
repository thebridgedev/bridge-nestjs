---
title: Assign roles to users
description: Inviting users with a role and changing an existing user's role.
sidebar:
  label: NestJS
---

# Assign roles to users

## Inviting a new user with a role

```bash
bridge user invite --email jane@example.com --role SUPPORT --tenant-id <tenantId>
```

`--tenant-id` can be omitted if you've set the `BRIDGE_TENANT_ID` environment variable. `--role` can be omitted too — the user gets whichever role is marked `isDefault` for your app.

## Changing an existing user's role

```bash
bridge user update --user-id <userId> --role ADMIN --tenant-id <tenantId>
```

## From your own backend

`@nebulr-group/bridge-nestjs` doesn't ship a management API client for user/role administration — that surface is CLI and Control Center today. If you're building your own admin endpoints (a settings page backed by your NestJS app, for instance), the pattern is to have your backend call Bridge's management API directly, forwarding an appropriately-privileged credential:

```typescript
import { Controller, Post, Body, Req } from '@nestjs/common';
import { RequireRole, RequirePrivilege, BridgeHttpService } from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';

@Controller('admin/team')
export class TeamAdminController {
  constructor(private readonly bridgeHttpService: BridgeHttpService) {}

  @Post('update-role')
  @RequireRole('ADMIN')       // gate for signed-in admins calling this endpoint
  @RequirePrivilege('USER_WRITE') // gate for any API-token caller
  async updateRole(
    @Body() body: { userId: string; role: string; tenantId: string },
    @Req() req: Request,
  ) {
    // Forward the caller's own verified token, or a workspace API token,
    // to Bridge's user-role endpoint — see BridgeHttpService in Configuration.
    return this.bridgeHttpService.post(
      `https://api.thebridge.dev/auth/account/user/${body.userId}`,
      { role: body.role, tenantId: body.tenantId },
      req.bridgeAccessToken,
    );
  }
}
```

Whichever path issues the change (CLI, Control Center, or your own backend proxying to Bridge), the [owner-role rules](/auth/roles/owner-role/) are enforced by Bridge itself — plan for the "at least one owner" rejection wherever your app surfaces a role-change action.
