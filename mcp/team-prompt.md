# Bridge NestJS — Team & Workspace

**Read this first: there is no team-management API in this plugin, and that is deliberate.**

If you came here looking for `listMembers()`, `inviteUser()`, `updateRole()` or a `TeamService`, stop looking. They do not exist in `@nebulr-group/bridge-nestjs`, they are not coming, and the time you spend grepping for them is wasted. This guide exists to say that in one place instead of letting you discover it by exhaustion.

## Decide first — where does this belong?

| What you want | Where it lives |
|---|---|
| A UI to list, invite, remove or re-role members | The **frontend** Bridge plugin — `TeamManagementPanel` in svelte / react / nextjs |
| Programmatic member CRUD from a script or backend job | The **Bridge management API**, via MCP tools or `bridge user …` / `bridge tenant …` on the CLI |
| Know which workspace the current request belongs to | This plugin — `@CurrentTenant()` |
| Gate a handler on the caller's role in that workspace | This plugin — `@RequireRole()` |
| Store your own per-workspace data | Your database, keyed by the tenant id from `@CurrentTenant()` |

The split is not arbitrary. Team membership is Bridge platform state, owned by bridge-api. A backend plugin that also mutated it would be a second writer to somebody else's data, with its own cache and its own idea of what a role means.

## What this plugin does give you

### The current workspace

```ts
import { Controller, Get } from '@nestjs/common';
import { CurrentTenant, CurrentUser, type BridgeTenant, type BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('cases')
export class CaseController {
  @Get()
  async list(@CurrentTenant() tenant: BridgeTenant, @CurrentUser() user: BridgeUser) {
    // tenant.id is the workspace this request belongs to. Scope EVERY query by
    // it — this is the line that keeps one customer's data out of another's.
    return this.cases.findAllByTenant(tenant.id);
  }
}
```

Both come from the verified JWT. There is no extra network call, and no way for a caller to spoof them without a valid signature.

> **Scope by `tenant.id`, always.** A missing tenant filter is the single most damaging bug available in a multi-tenant backend, and it is invisible in testing with one workspace. If a query cannot be scoped, be able to say why.

### Gating on role

```ts
import { Controller, Delete, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, RequireRole } from '@nebulr-group/bridge-nestjs';

@Controller('workspace')
@UseGuards(BridgeAuthGuard)
export class WorkspaceController {
  @Delete('members/:id')
  @RequireRole('OWNER')
  async removeMember() {
    // Your own logic. Removing the member from BRIDGE is a management-API
    // call, not something this plugin can do.
  }
}
```

Roles come from the token: `OWNER`, `ADMIN`, and whatever custom roles the app defines. `@RequirePrivilege()` is the finer-grained version and is usually the better choice — privileges survive a role rename.

## Managing members for real

Over MCP:

| Task | Tool |
|---|---|
| List workspaces | `list_tenants` |
| Create a workspace | `create_tenant` |
| Add a user to a workspace | `create_tenant_user` |
| Change a member's role | `update_tenant_user` |
| Remove a member | `delete_tenant_user` — destructive, needs confirmation |

On the CLI: `bridge tenant list`, `bridge tenant create`, `bridge user invite`, `bridge user update`, `bridge user delete`.

Both channels are equivalent. Use whichever the caller has; do not send someone to the dashboard just because you happen to have one of them.

> Destructive operations (anything that deletes) require a token carrying the matching privilege. A default `bridge auth login` token deliberately has none — `bridge auth login --admin` requests them. Over MCP the token needs the destructive privilege enabled explicitly, and the tool will ask for confirmation.

## Common mistakes

- **Building a `/team/members` proxy endpoint in your API** that forwards to Bridge. The frontend plugin already talks to Bridge directly with the user's token. A proxy adds a hop, a second place for the role logic to drift, and a new way to leak another workspace's members.
- **Caching membership in your own database.** It goes stale the moment someone is removed, and the stale copy is the one your authorization check reads.
- **Trusting a `tenantId` from the request body or a query parameter.** Use `@CurrentTenant()`. A body field is caller-controlled; the JWT claim is not.
- **Assuming `OWNER` implies every privilege.** Check the privilege you actually need.

## Related guides

- `integration-prompt.md` — wiring `BridgeModule` in, if you have not yet
- `auth-prompt.md` — token verification, `@RequirePrivilege`, API-token vs user-token
- The frontend plugin's `team-prompt.md` — where the UI actually goes
