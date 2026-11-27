# Bridge NestJS 1.0 — Feature flags

You are gating NestJS endpoints and behaviour with Bridge flags, using `@nebulr-group/bridge-nestjs` 1.0. The server is where a gate is enforced: anyone can call the API directly, so the flag check lives on the handler. The frontend asks the same flags to show or hide the matching UI.

## The one rule for app code

**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains "users:write"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.

Two things are not gates and are not flags: **numbers** are plan limits (`<QuotaGate>` in the browser, `@RequireQuota` on the backend), and **permission on one specific record** stays in app code ("only the author edits their post").

Before calling the work done, run `npx @nebulr-group/bridge-cli@alpha check gates` in the project. It lists every direct role, privilege, plan or plan-feature check with the flag to use instead. Fix each one.

In NestJS, an endpoint is `@RequireFlag('…')` on the handler (or a route rule with `featureFlag`).

## Decide first — which surface?

| You are gating | Use |
|---|---|
| A whole endpoint | `@RequireFlag('key')` on the handler or controller, or a rule's `featureFlag` |
| Several flags | `@RequireFlag({ any: ['a', 'b'] })` or `{ all: [...] }` |
| A value inside the handler (a page size, a variant) | `@Flag('key', fallback)` as a parameter |
| Several values, or a reason | `@Flags()` (a `FlagSet`) or `BridgeService.flags(request)` |
| Code with no request (a job, startup) | `BridgeService.visitorFlags(hints)`: public flags only |

All of them need the module (`BridgeModule.forRoot(...)`, see the integration guide) and the guard on the route: the guard reads the caller's results once per request and the decorators use them.

## Gate an endpoint

```ts
import { Controller, Get, Post } from '@nestjs/common';
import { Flag, RequireFlag } from '@nebulr-group/bridge-nestjs';

@Controller('reports')
export class ReportsController {
  @RequireFlag('reports')
  @Get()
  list(@Flag('reports-page-size', 20) pageSize: number) { … }

  @RequireFlag({ all: ['reports', 'reports-export'] })
  @Post('export')
  export() { … }
}
```

`@RequireFeatureFlag` is the same decorator under its 0.x name. A rule does the same without a decorator: `{ path: '/reports/**', privilege: 'AUTHENTICATED', featureFlag: 'reports' }`.

### The refusals

| Status | `code` | When |
|---|---|---|
| `402` | `FEATURE_NOT_IN_PLAN` | A plan feature (or a used-up limit) keeps the flag off: an upgrade would turn it on. `feature` names it, `fix` is the module's `manageRoute` (default `/subscription`). The body is also an RFC 9457 problem (`urn:bridge:problem:entitlement-missing` or `urn:bridge:problem:limit-reached`). |
| `403` | `FEATURE_OFF` | Any other reason the flag is off for this caller. |

The frontend plugin's `bridgeFetch` opens the upgrade dialog on the `402`; nothing to add on the server.

## Read values and reasons

```ts
import { Flags, type FlagSet } from '@nebulr-group/bridge-nestjs';

@Get('home')
home(@Flags() flags: FlagSet) {
  const hero = flags.get('home-hero', 'classic');     // the value, or the fallback
  const beta = flags.enabled('beta');                 // off unless Bridge said on
  const why = flags.reason('beta');                   // { reason, why, entitlement }
}
```

`BridgeService.enabled(request, key)` and `BridgeService.flags(request)` do the same outside a decorator. A value whose type does not match the fallback gives the fallback.

## Configure the flag and its rule

The flag's rule is where "why" lives. Over MCP: `create_feature_flag`, `update_feature_flag`, `toggle_feature_flag`, `evaluate_feature_flag`. From a terminal (CLI 1.0):

```bash
bridge flag create reports --when "privileges contains reports:read"
bridge flag create analytics --when "bridge:billing.entitlement.analytics eq true"
bridge flag create new-editor --when "privileges contains notes:write" --rollout 25
bridge flag create reports-page-size --type number --on-value 50 --off-value 20
bridge flag on reports
bridge flag off reports
bridge flag get reports
bridge flag eval reports --context '{"privileges":["reports:read"]}'
```

Who should get a feature (everyone, a share, a plan, named workspaces) is the developer's decision: ask before writing the rule. Rules read the caller as Bridge knows them (`privileges`, `user.*`, `tenant.*`) and the workspace's billing (`bridge:billing.entitlement.<feature>`, `bridge:billing.quota.<metric>.limit`, `.used`, `.remaining`). Never send a fact the caller supplied as if it were true.

## How the server stays current

There is nothing to keep current. For each request the guard asks Bridge for the caller's results, once, and the decorators share that answer. A flag turned off, a rule changed or a plan upgraded in Bridge applies from the next request: no restart, no cache to clear, and no live connection to hold open. Bridge sends no webhook for flag changes, and the server needs none.

- **Signed-in callers and keys:** asked per request, never cached across requests.
- **Visitors** (a `@Public()` route with no credential, or `visitorFlags()`): only flags marked public give a result; an answer is kept 10 seconds per set of facts, so a busy public route does not ask Bridge each time.
- **A long-running job:** ask again at each unit of work instead of keeping one `FlagSet` for the job's life.
- **When Bridge cannot answer:** every flag gives its fallback, so a gate stays closed (`@RequireFlag` refuses) and `@Flag` returns the fallback you wrote.

## Public flags

A flag marked public (`bridge flag create <key> --public`, or `bridge flag update <key> --public`) is what Bridge shows anyone, signed in or not. On a `@Public()` route a flag that is not public is absent: `@RequireFlag` on it refuses `403 FEATURE_OFF` and `@Flag` gives its fallback. Nothing is sent with the question, so the app key never speaks for a stranger.

```ts
@Public()
@Get('banner')
banner(@Flag('signup-banner', false) show: boolean) { … }
```

For code with no request: `this.bridge.visitorFlags({ country: 'SE' })` with facts your server knows.

## Keys

A key passes a flag gate when the flag's rule matches the key's privileges; otherwise `403 FEATURE_OFF`. A key on a route with no gate at all is refused `403 KEY_ROUTE_NOT_OPEN` (see the auth guide).

## Troubleshooting

- **Always `403 FEATURE_OFF`:** work out what the rule gives a caller with `bridge flag eval <key> --context '<the caller's facts as JSON>'`; read the rule with `bridge flag rule show <key>`.
- **`@Flag` always gives the fallback:** the route has no guard (no credential is read), the fallback's type differs from the flag's, or it is a `@Public()` route and the flag is not public.
- **A route rule never matches:** write `path` as the route is declared, with the global prefix (`/api/reports/:id`), not as a concrete URL.

## Verify

### Terminal checks

1. `npm run build` passes.
2. `bridge flag get <key>` shows the rule the developer asked for.
3. With the flag off (`bridge flag off <key>`), the gated endpoint called with a signed-in person's token answers `403 FEATURE_OFF` (or `402 FEATURE_NOT_IN_PLAN` when a plan feature keeps it off). With it on, it answers `2xx`. Called with no token, it answers `401`.
4. `npx @nebulr-group/bridge-cli@alpha check gates` lists nothing.

### Browser checks

1. In the frontend, the UI the flag gates shows when the flag is on and hides when it is off, without a reload.
2. A person the rule does not match does not see it, and calling the endpoint from the frontend is refused.

Run the terminal checks. If you have a browser tool, run the browser checks too. If you do not, list them for the developer, numbered, and start the summary with a Heads up line saying which checks were not run. That line starts "Heads up: not verified in a browser".
