# Bridge NestJS 1.0 — Integration

You are adding The Bridge to a NestJS API with `@nebulr-group/bridge-nestjs` 1.0. The plugin checks every request's credential, gates endpoints with flags, holds and counts plan limits, calls Bridge's management API with the app's key, and checks Bridge's webhooks. This guide is the first-time setup; the topic guides (auth, feature-flags, billing, team) go deeper.

## The one rule for app code

**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains "users:write"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.

Two things are not gates and are not flags: **numbers** are plan limits (`<QuotaGate>` in the browser, `@RequireQuota` on the backend), and **permission on one specific record** stays in app code ("only the author edits their post").

Before calling the work done, run `npx @nebulr-group/bridge-cli@alpha check gates` in the project. It lists every direct role, privilege, plan or plan-feature check with the flag to use instead. Fix each one.

In NestJS, an endpoint is `@RequireFlag('…')` on the handler (or a route rule with `featureFlag`).

## Which line you are on

1.0 is in alpha and works with the new Bridge only. Install from the `alpha` tag, never `latest`: the 0.x plugin talks to the old Bridge API and fails here.

| You need | 1.0 |
|---|---|
| Settings | `BRIDGE_ISSUER` (required), `BRIDGE_APP_KEY` (server only, for counting, limits and the management client), `BRIDGE_WEBHOOK_SECRETS` (only if the app receives webhooks) |
| Who is calling | `@CurrentActor()`: `{ kind, id, personId, workspaceId, sessionId, appId, standing }` |
| A gate | `@RequireFlag('key')`, or a route rule with `featureFlag` |
| A number | `@RequireQuota('metric')`, `@SyncQuota`, `BridgeQuotaService` |
| "Count this" | `@Meter('metric')`, `BridgeService.count()` |
| Bridge's API | `BridgeManagementService` |
| Webhooks | `@BridgeWebhook()` with `@WebhookEvent()` |

There is no API base URL and no app id setting: everything else (key set, revocation list, API addresses) is read from the issuer.

## Prerequisites

1. An app on Bridge. Over MCP: `create_app`, or `use_app` for an existing one. From a terminal (CLI 1.0, `npm i -g @nebulr-group/bridge-cli@alpha`): `bridge auth login`, then `bridge app create --name "<name>"` or `bridge app use <id>`.
2. The app's issuer. Over MCP: `get_environment_info` (`issuer`). From a terminal: `bridge app get`, or let `bridge app setup --var BRIDGE_ISSUER --dotenv .env --url <frontend origin>` write it into the backend's `.env` (it also adds the frontend's origin as a browser origin and its `/auth` page as the email-links address).
3. NestJS 10, 11 or 12, Node 20.19 or later.

## Install

```bash
npm i @nebulr-group/bridge-nestjs@alpha
```

The plugin brings `@nebulr-group/bridge-auth-core` with it; the app does not depend on it directly.

## Settings

```bash
# .env (server only; never in a browser bundle)
BRIDGE_ISSUER=https://<bridge>/identity-access/apps/<app id>
BRIDGE_APP_KEY=…            # bridge key create --name "api server" --privilege billing.usage:write
BRIDGE_WEBHOOK_SECRETS=…    # the signing secret from the dashboard's Webhooks page; "new,old" during a rotation
```

`BRIDGE_APP_KEY` is an app key. Make one with `bridge key create --name "<what it is for>" --privilege billing.usage:write` (the secret is shown once; put it in the server's secrets). Counting usage and holding plan limits need `billing.usage:write`. Skip the key if the app neither counts, limits nor calls the management API.

## Register the module

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';

@Module({
  imports: [BridgeModule.forRoot({ guard: { global: true } })],
})
export class AppModule {}
```

`forRoot()` reads `BRIDGE_ISSUER`, `BRIDGE_APP_KEY` and `BRIDGE_WEBHOOK_SECRETS` from the environment when they are not passed. With a config service, `BridgeModule.forRootAsync({ imports, inject, useFactory })` returns the same settings.

With `guard: { global: true }` every route needs a valid credential unless it says `@Public()` or a rule opens it. Without it, put `@UseGuards(BridgeAuthGuard)` on each controller that needs one.

If the app receives webhooks, create it with the raw body, so signatures are checked over the bytes as they arrived:

```ts
// main.ts
const app = await NestFactory.create(AppModule, { rawBody: true });
```

## Public routes and the caller

```ts
import { Controller, Get } from '@nestjs/common';
import { BridgeService, CurrentActor, Public, type Actor } from '@nebulr-group/bridge-nestjs';

@Controller()
export class AppController {
  constructor(private readonly bridge: BridgeService) {}

  @Public()
  @Get('health')
  health() {
    const status = this.bridge.status();
    return { ok: true, revocationList: status === null ? 'starting' : { ready: status.ready } };
  }

  @Get('me')
  me(@CurrentActor() actor: Actor) {
    return actor;
  }
}
```

The workspace a request acts in is `actor.workspaceId` (`@CurrentActor('workspaceId')`). It comes from the verified token only: never take a workspace id from the body, a query or a header the client sent.

## The frontend calls the API with the person's token

The guard reads `Authorization: Bearer <access token>` (a person) or `x-api-key` (a key). A SvelteKit frontend on `@nebulr-group/bridge-svelte` 1.0 calls the API with `bridgeFetch`, which adds the token and opens the upgrade dialog on a plan refusal; list the API's origin in the frontend's `tokenOrigins` when it runs on another origin. Allow the frontend's origin in Nest's own CORS settings (`app.enableCors({ origin: [...] })`).

## Where to go next

- **auth** (`get_integration_guide topic=auth framework=nestjs`, `bridge guide nestjs auth`): the guard, keys, `@AcceptAuth`, `@Strict`.
- **feature-flags**: `@RequireFlag`, `@Flag`, rules, public flags.
- **billing**: plan limits, plan features, reading the workspace's plan, the refusals your frontend reads.
- **team**: the workspace, members and invites from the server, webhooks for team changes.
- Shared guides: `fit-together` (how roles, plans, limits and flags fit) before setting up any of them; `mechanisms` for how limits and upgrades work.

Checkout, the plan picker and the Stripe redirect live in the frontend plugin and in Bridge. Do not add payments code to the backend.

## Verify

### Terminal checks

1. `npm run build` passes.
2. Start the app. `curl -i http://localhost:3000/health` answers `200`.
3. `curl -i http://localhost:3000/me` with no token answers `401` with a `WWW-Authenticate` header.
4. `npx @nebulr-group/bridge-cli@alpha check gates` lists nothing.

### Browser checks

1. Sign in in the frontend, then call `/me` from it (through `bridgeFetch`): the answer is the Actor, with a `workspaceId`.

Run the terminal checks. If you have a browser tool, run the browser checks too. If you do not, list them for the developer, numbered, and start the summary with a Heads up line saying which checks were not run. That line starts "Heads up: not verified in a browser".
