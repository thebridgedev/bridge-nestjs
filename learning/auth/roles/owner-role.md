---
title: The owner role
description: Rules Bridge enforces around the OWNER role, and how to handle them from your backend.
sidebar:
  label: NestJS
---

# The owner role

Every workspace (called a *tenant* in the API) has an `OWNER` role, and Bridge enforces some rules around it that you'll want to know before you hit them:

- **Every workspace must have at least one owner.** Whoever creates a workspace becomes its first `OWNER` automatically.
- **You can't demote the last owner.** Changing a user's role away from `OWNER` is blocked if they're the only owner left in the workspace; the API rejects it with "There must be at least one owner for this workspace." Promote someone else to `OWNER` first, then demote the original one.
- **The `OWNER` role itself can't be deleted, and its key can't be changed to something else.** You can still edit its name, description, or (carefully) its privilege set.

`OWNER` is granted the broadest default privilege set (`AUTHENTICATED`, `USER_READ`, `USER_WRITE`, `TENANT_READ`, `TENANT_WRITE`). Treat it as the role for whoever is ultimately accountable for the workspace, not a role you hand out casually.

## What this means for your backend

If your NestJS app exposes an endpoint that changes a user's role (proxying to Bridge's management API, as in [Assign roles to users](/auth/roles/assign-roles/)), that call can be rejected with the "at least one owner" error. Surface it as a normal validation error rather than letting it bubble up as a generic 500:

```typescript
import { Controller, Post, Body, HttpException, HttpStatus } from '@nestjs/common';
import { BridgeHttpService, BridgeHttpError } from '@nebulr-group/bridge-nestjs';

@Controller('admin/team')
export class TeamAdminController {
  constructor(private readonly bridgeHttpService: BridgeHttpService) {}

  @Post('update-role')
  async updateRole(@Body() body: { userId: string; role: string; tenantId: string }) {
    try {
      return await this.bridgeHttpService.post(
        `https://api.thebridge.dev/auth/account/user/${body.userId}`,
        { role: body.role, tenantId: body.tenantId },
      );
    } catch (err) {
      // BridgeHttpError carries the upstream status + URL. Inspect the
      // response body (fetch it yourself, or extend BridgeHttpService's
      // request wrapper) to detect the "at least one owner" rejection and
      // turn it into a clean 4xx for your own API consumers instead of a 500.
      if (err instanceof BridgeHttpError) {
        throw new HttpException(
          'Could not update this user\'s role. They may be the only owner of the workspace; promote someone else first.',
          HttpStatus.BAD_REQUEST,
        );
      }
      throw err;
    }
  }
}
```

If a user's role is `OWNER`, plan your own authorization logic (not just Bridge's) to expect that they always retain access; don't build a code path in your app that could lock every owner out of their own workspace.
