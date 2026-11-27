# Bridge NestJS 1.0 — Authentication & access

How `@nebulr-group/bridge-nestjs` 1.0 decides who may call a route: the guard checks the credential, a flag decides who gets the route, and app code decides about one specific record. Read the integration guide first if the module is not registered yet.

## The one rule for app code

**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains "users:write"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.

Two things are not gates and are not flags: **numbers** are plan limits (`<QuotaGate>` in the browser, `@RequireQuota` on the backend), and **permission on one specific record** stays in app code ("only the author edits their post").

Before calling the work done, run `npx @nebulr-group/bridge-cli@alpha check gates` in the project. It lists every direct role, privilege, plan or plan-feature check with the flag to use instead. Fix each one.

In NestJS, an endpoint is `@RequireFlag('…')` on the handler (or a route rule with `featureFlag`).

## Decide first

| You want | Use |
|---|---|
| Every route needs a signed-in caller unless marked | `BridgeModule.forRoot({ guard: { global: true } })` and `@Public()` on the exceptions |
| Only some controllers protected | `@UseGuards(BridgeAuthGuard)` on those controllers |
| Some people get a route, others do not | `@RequireFlag('key')`; the flag's rule names the privilege, plan feature or rollout |
| Only a person's token, or only a key | `@AcceptAuth('jwt')` / `@AcceptAuth('api_token')` |
| A sensitive read checked as tightly as a write | `@Strict()` |
| One specific record ("only the author edits it") | App code, comparing the record's owner with `actor.personId` |

The Actor carries no role and no privileges, on purpose. A role or privilege check in a handler is the mistake `bridge check gates` reports.

## What the guard checks

The guard reads `Authorization: Bearer <token>` (a person's access token) or `x-api-key` (a personal, service account or app key) and checks:

- the signature against the app's key set, the issuer, the audience and the expiry;
- the app's revocation list, followed every 2 seconds: an ended session, a removed member or a revoked key is refused within seconds, not when the token expires;
- writes (POST, PUT, PATCH, DELETE) against a list at most 30 seconds behind (`guard.strictWrites`, on by default). `@Strict()` does the same for a read; `@Strict(false)` relaxes one write.

A refused credential gets `401` with `WWW-Authenticate`. While Bridge cannot be checked the guard answers `503` with `Retry-After`, never yes.

A signed-in person's write in a workspace that is suspended or scheduled for deletion is refused with `403` (`urn:bridge:problem:workspace-not-active`), and in a workspace locked for payment with `402 BILLING_GATE_ENGAGED`. Reads are never refused for these reasons. There is nothing to add for this.

## Read the caller

```ts
import { Controller, Get, Param } from '@nestjs/common';
import { CurrentActor, type Actor } from '@nebulr-group/bridge-nestjs';

@Controller('notes')
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get(':id')
  async get(@CurrentActor() actor: Actor, @Param('id') id: string) {
    // The workspace comes from the verified token; one record's owner is app code.
    return this.notes.findInWorkspace(actor.workspaceId!, id);
  }
}
```

| Field | What it is |
|---|---|
| `kind` | `person`, `personal_key`, `service_account_key`, `app_key` or `job` |
| `id` | The person's, key's or job's id |
| `personId` | The person behind the call (also for a personal key), or null |
| `workspaceId` | The workspace the call acts in, or null when the credential names none |
| `sessionId`, `appId`, `standing` | The sign-in session, the app, the workspace's standing (`active`, …) |

`@CurrentActor('workspaceId')` gives one field. Outside a decorator, `BridgeService.actorOf(request)` gives the Actor the guard verified, and `BridgeService.verify(request)` checks a request yourself (it throws a `BridgeError`: 401, or 503 while Bridge cannot be checked).

## Gate who gets a route with a flag

```ts
@RequireFlag('reports')
@Get('reports')
reports() { … }
```

Create the flag with its rule. Over MCP: `create_feature_flag`. From a terminal:

```bash
bridge flag create reports --when "privileges contains reports:read"
```

A route rule does the same from one list, when that reads better than decorators:

```ts
BridgeModule.forRoot({
  guard: {
    global: true,
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/webhooks/**', privilege: 'ANONYMOUS' },
      { path: '/reports/*', privilege: 'AUTHENTICATED', featureFlag: 'reports' },
    ],
  },
});
```

`privilege` in a rule is only `ANONYMOUS` (open to everyone) or `AUTHENTICATED` (a valid credential). A `path` is matched against the route as declared (`/reports/:id`, with any global prefix), never the URL the client sent: `*` is one segment, `**` any number. GraphQL resolvers use `graphqlField: 'Query.catalog'`. A decorator on the handler wins over a rule. The feature-flags guide covers refusals (`403 FEATURE_OFF`, `402 FEATURE_NOT_IN_PLAN`).

## Keys

A request with `x-api-key` reaches a route only when a flag gates it and the flag is on for the key (put the key's privilege in the flag's rule), or when the route is open on purpose (`@Public()`, an `ANONYMOUS` rule, or `guard.defaultAccess: 'public'`). Otherwise the answer is `403` with `code: 'KEY_ROUTE_NOT_OPEN'`. A person's request is not affected.

```ts
@RequireFlag('reports')   // rule: privileges contains reports:read, which the key holds
@Get('reports')
reports() { … }
```

App keys are made with `bridge key create --name "<what for>" --privilege <privilege>` and revoked with `bridge key revoke <id>` (refused within seconds).

## Restrict the credential

```ts
@AcceptAuth('jwt')        // a person's token only
@Post('profile')
update() { … }

@AcceptAuth('api_token')  // keys only
@Post('import')
import() { … }
```

`both` is the default.

## Public routes

`@Public()` opens a route to everyone, keys included. A public route still reads flags: only flags marked public (`bridge flag create <key> --public`, or `--public` on `bridge flag update`) give a result; every other flag gives its fallback. A webhook receiver (`@BridgeWebhook()`) is public and checked by signature instead.

## Sign-in itself happens in the frontend

The backend never shows a sign-in page and never handles a password. People sign in in the frontend (bridge-svelte 1.0: `BridgeAuthRoutes`), which sends their access token to this API. Which sign-in methods exist is app configuration: over MCP `update_auth_methods`, from a terminal `bridge auth methods enable <method>`.

## Access checklist

- [ ] The guard runs on every route that needs a credential (global, or `@UseGuards(BridgeAuthGuard)`).
- [ ] Every route some people get and others do not has `@RequireFlag` or a rule's `featureFlag`.
- [ ] No handler reads a role, a privilege or the plan.
- [ ] The workspace comes from `@CurrentActor('workspaceId')`, never from the request body.
- [ ] Routes open to everyone say `@Public()` on purpose.

## Verify

### Terminal checks

1. `npm run build` passes.
2. A protected route without a token: `curl -i http://localhost:3000/me` answers `401`.
3. A route gated by a flag, called with a key whose privilege the rule does not name, answers `403 FEATURE_OFF`; a route with no gate called with a key answers `403 KEY_ROUTE_NOT_OPEN`.
4. `bridge flag get <key>` shows the rule you meant.
5. `npx @nebulr-group/bridge-cli@alpha check gates` lists nothing.

### Browser checks

1. Signed in in the frontend, the gated route answers for a person whose privileges the rule names, and is refused for one whose privileges it does not.

Run the terminal checks. If you have a browser tool, run the browser checks too. If you do not, list them for the developer, numbered, and start the summary with a Heads up line saying which checks were not run. That line starts "Heads up: not verified in a browser".
