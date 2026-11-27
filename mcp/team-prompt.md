# Bridge NestJS 1.0 — Team, workspaces and webhooks

How a NestJS API on `@nebulr-group/bridge-nestjs` 1.0 works with workspaces and their members: the caller's workspace on each request, the management client for members and invites, and Bridge's webhooks for plan and team changes.

## The one rule for app code

**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains "users:write"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.

Two things are not gates and are not flags: **numbers** are plan limits (`<QuotaGate>` in the browser, `@RequireQuota` on the backend), and **permission on one specific record** stays in app code ("only the author edits their post").

Before calling the work done, run `npx @nebulr-group/bridge-cli@alpha check gates` in the project. It lists every direct role, privilege, plan or plan-feature check with the flag to use instead. Fix each one.

In NestJS, an endpoint is `@RequireFlag('…')` on the handler (or a route rule with `featureFlag`).

## Decide first — where does it belong?

| You want | Where |
|---|---|
| The team page: members, invites, roles | The frontend plugin (bridge-svelte 1.0: `TeamPanel`). It calls Bridge directly; the backend adds nothing. |
| Scope your own data to the caller's workspace | `@CurrentActor('workspaceId')` on every handler |
| Who may manage the team in your own endpoints | A flag: Bridge's own `bridge-team-manage`, or one of yours ruled on a privilege |
| Members or invites from your server (provisioning, an import, an admin tool) | `BridgeManagementService` |
| React when a workspace, member or subscription changes | A webhook receiver: `@BridgeWebhook()` |
| Which roles exist and what each may do | App configuration, decided with the developer: over MCP `create_role`, `update_role`; from a terminal `bridge role create <key> --name <name> --privilege <privilege>` |

## The caller's workspace

```ts
@Get('projects')
list(@CurrentActor('workspaceId') workspaceId: string) {
  return this.projects.findAll({ workspaceId });
}
```

The workspace comes from the verified token. Never take it from the body, the query or a header the client sent. A person who belongs to several workspaces switches in the frontend; the next token names the new workspace.

## Members and invites from the server

`BridgeManagementService` calls Bridge's API. Call as the person who called your API when Bridge should apply their privileges:

```ts
import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { BridgeManagementService, RequireFlag } from '@nebulr-group/bridge-nestjs';

@Controller('team')
export class TeamController {
  constructor(private readonly management: BridgeManagementService) {}

  @RequireFlag('bridge-team-manage')
  @Get('members')
  members(@Req() request: { headers: unknown }) {
    return this.management.forCaller(request).workspace.members.list();
  }

  @RequireFlag('bridge-team-manage')
  @Post('invites')
  invite(@Req() request: { headers: unknown }, @Body() body: { email: string; role?: string }) {
    return this.management.forCaller(request).workspace.invites.send(body);
  }
}
```

With the app key, for work no person started (a provisioning job): `this.management.workspaces.create({ name })`, then `this.management.workspace(workspaceId)` with `members.list()`, `members.update(id, patch)`, `members.remove(id)`, `invites.list()`, `invites.send({ email, role })`, `invites.cancel(id)`. The app key needs the privileges those calls ask for; a refusal throws a `BridgeError` (`kind: 'forbidden'`, `status`, `code`).

A workspace's own key (for its CI or integrations): `this.management.forCaller(request).workspaceKeys.create({ name, privileges })`, shown once.

Which role an invitee gets is the developer's decision: ask, never pick one.

## Webhooks

Bridge sends the app's server a signed POST for workspace, member and billing changes. Set the receiver's address and read the signing secret on the Bridge dashboard's Webhooks page for the app (the address must be public https). Put the secret in `BRIDGE_WEBHOOK_SECRETS`.

```ts
// main.ts: signatures are checked over the body exactly as it arrived
const app = await NestFactory.create(AppModule, { rawBody: true });
```

```ts
import { Controller, HttpCode, Post } from '@nestjs/common';
import { BridgeWebhook, WebhookEvent, type BridgeWebhookEvent } from '@nebulr-group/bridge-nestjs';

interface Delivery {
  id: string;
  type: string;
  created: number;
  app_id: string;
  workspace_id?: string;
  data: Record<string, unknown>;
}

@Controller('webhooks')
export class WebhooksController {
  @BridgeWebhook()
  @HttpCode(204)
  @Post('bridge')
  async receive(@WebhookEvent() event: BridgeWebhookEvent<Delivery>) {
    if (await this.seen.has(event.id)) return;        // the same id across retries and replays
    switch (event.type) {
      case 'subscription.plan_changed':               // data: { workspaceId, fromPlan, toPlan }
      case 'tenant_user.created':                     // data: the member (id, email, role, …)
      case 'tenant_user.deleted':                     // data: { id }
        await this.sync.apply(event.type, event.payload.data);
    }
    await this.seen.add(event.id);
  }
}
```

`@BridgeWebhook()` makes the route public and checks `Bridge-Signature` (`t=<seconds>,v1=<HMAC-SHA256>`) against your secrets; a delivery older than 5 minutes or signed with another secret is refused `401`. When you rotate the secret, Bridge signs with both for 24 hours: set `BRIDGE_WEBHOOK_SECRETS=new,old`, then drop the old one. Outside NestJS, `verifyWebhook({ body, headers, secrets })` does the same.

Answer quickly with a `2xx`; Bridge retries a failed delivery for about four days, with the same event id. Handle each id once.

The event types Bridge sends:

| Area | Types |
|---|---|
| Workspaces | `tenant.created`, `tenant.updated`, `tenant.deleted` |
| Members | `tenant_user.created` (joined: invite accepted or sign-up), `tenant_user.updated` (role or profile), `tenant_user.deleted` (left or removed) |
| Subscriptions | `subscription.created`, `subscription.plan_changed`, `subscription.trial_started`, `subscription.trial_will_end`, `subscription.trial_ended`, `subscription.past_due`, `subscription.reactivated`, `subscription.canceled` |
| Payments and limits | `payment.succeeded`, `payment.failed`, `quota.exhausted`, `entitlements.changed`, `usage.drift_resolved`, `usage.drift_unrecoverable` |

Flag changes are not webhooks: the server reads a caller's flags from Bridge on each request, so a change applies from the next one (feature-flags guide).

## Common mistakes

- Reading a role or privilege in a handler to decide who may manage the team: gate with a flag instead.
- Taking the workspace id from the request body.
- Parsing the webhook body before the check (`rawBody: true` is required) or handling a retried id twice.
- Building a team page on the backend when the frontend plugin's `TeamPanel` already does it.

## Verify

### Terminal checks

1. `npm run build` passes.
2. A POST to the webhook route with no or a wrong `Bridge-Signature` answers `401`.
3. `curl -i -H "Authorization: Bearer <token>" http://localhost:3000/team/members` for a person the flag lets through answers the member list; for one it does not, `403 FEATURE_OFF`.
4. `npx @nebulr-group/bridge-cli@alpha check gates` lists nothing.

### Browser checks

1. Invite a teammate from the frontend's team page, accept the invite in another browser: the receiver logs `tenant_user.created`.
2. Change the workspace's plan in the frontend's plan page: the receiver logs `subscription.plan_changed`.

Run the terminal checks. If you have a browser tool, run the browser checks too. If you do not, list them for the developer, numbered, and start the summary with a Heads up line saying which checks were not run. That line starts "Heads up: not verified in a browser".
