# Bridge NestJS Integration

You are integrating The Bridge into a NestJS application. This adds JWT-based authentication, tenant context, flag-gated access control, API-token scopes and plan limits to your API.

## The one rule for app code

**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains "USER_WRITE"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.

Two things are not gates and are not flags: **numbers** are plan limits (`<QuotaGate>` in the browser, `@RequireQuota` on the backend), and **permission on one specific record** stays in app code ("only the author edits their post").

Before calling the work done, run `npx @nebulr-group/bridge-cli check gates` in the project. It lists every direct role, privilege, plan or plan-feature check with the flag to use instead. Fix each one.

In NestJS, an endpoint is `@RequireFeatureFlag('…')` on the handler (or a route rule with `featureFlag`).

## What this integration is

This is a **backend** integration: there are no UI components, no login screen, and no checkout redirect. The frontend (a Bridge frontend plugin — svelte/react/nextjs/angular) handles login and obtains the user's access token; this plugin verifies that token on every request and exposes the verified identity to your controllers and resolvers.

**The whole integration is two lines in `AppModule` and one environment variable.** A plan limit is one more decorator per handler (`bridge guide nestjs billing`). `bridge guide mechanisms` explains the model: the server decides, the client decorates, and a POST increments the limit.

```ts
// src/app.module.ts
import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';

@Module({
  imports: [BridgeModule.forRoot({ guard: { global: true } })],
})
export class AppModule {}
```

```env
# .env
BRIDGE_APP_ID=your-app-id
# Only for a stage, local or self-hosted app:
# BRIDGE_API_BASE_URL=https://api-stage.thebridge.dev
```

NestJS does not read `.env` by itself, and `BridgeModule.forRoot()` reads the environment when `AppModule` is loaded, so the variables must be in the process before it starts: `node --env-file=.env dist/main.js` (Node 20.6+), your container's environment, or `forRootAsync` with `@nestjs/config` (below).

## Decide first — how do routes get protected?

Protection here is **declarative**. It lives in `BridgeModule.forRoot()` and in decorators, not in checks you write inside handlers. Make this decision before you touch a controller: retrofitting it means auditing every route in the app.

| You want | Declare it |
|---|---|
| Every route protected unless stated otherwise | `guard: { global: true, defaultAccess: 'protected' }` in `BridgeModule.forRoot()` |
| Only certain controllers protected | leave `guard.global` off, put `@UseGuards(BridgeAuthGuard)` on those controllers |
| A whole path open to the world | a `rules` entry with `privilege: 'ANONYMOUS'` |
| One handler open on an otherwise-protected path | `@Public()` on that handler |
| A path or handler only some people get (a privilege, a plan feature, a rollout) | `featureFlag` on its `rules` entry, or `@RequireFeatureFlag('…')` on the handler — the flag's rule says why; see `feature-flags-prompt.md` and, for plan features, `billing-prompt.md` |
| A plan limit on the handler that creates the thing | `@RequireQuota('…')`, and `@SyncQuota` on the delete for things that exist — see `billing-prompt.md` |
| An API token (machine caller) to hold a scope | `@RequirePrivilege('…')` — API tokens only; see `auth-prompt.md` |
| Only server-to-server callers, or only browser users | `@AcceptAuth('api_token')` / `@AcceptAuth('jwt')` — see `auth-prompt.md` |

**`guard.global` plus `defaultAccess` is the entire switch**, and it is the one choice here with real blast radius. Set `global: true` with `defaultAccess: 'protected'` and a route you forget about is closed; leave the guard off and a route you forget about is open to the internet. Everything else in the table is a per-route correction layered on top of that default.

If the user has not said which they want, default to the global guard and mark exceptions — it fails safe.

## Prerequisites

- **appId** — your Bridge application ID. Get it from `bridge app get` or the Bridge dashboard.
- **Package manager** — use whatever the project already uses (check for `bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, or `package-lock.json`).
- An existing NestJS app (`@nestjs/common` and `@nestjs/core` ^10 or ^11).

## Migration check

Before starting, check if the project has existing auth.

**Migrating from `@nebulr/nblocks-nestjs` or a custom nblocks integration:**

| Old (nblocks) | New (bridge-nestjs) |
|---|---|
| `@nebulr/nblocks-nestjs` or custom JWT guards | `@nebulr-group/bridge-nestjs` package |
| Custom `AuthGuard` with manual JWKS | `BridgeAuthGuard` (built-in JWKS handling) |
| Custom `@User()` decorator | `@CurrentUser()` decorator |
| Manual tenant extraction from JWT | `@CurrentTenant()` decorator |
| `NBLOCKS_APP_ID` env var | `BRIDGE_APP_ID` env var |

**Migration steps:**
1. Remove old auth packages and custom guard/decorator files.
2. Install bridge-nestjs (see Install section).
3. Replace the `AppModule` auth-module imports with `BridgeModule.forRoot()`.
4. Replace custom decorators with Bridge equivalents.
5. Update environment variables.

**If no existing auth is found:** skip migration steps, proceed directly to Install.

## Install

```bash
npm i @nebulr-group/bridge-nestjs
```

Replace `npm i` with the project's package manager (`bun add`, `pnpm add`, `yarn add`).

`@nebulr-group/bridge-auth-core` is a peer dependency that npm, pnpm and bun install with it; there is no second package to add by hand. All JWT and API-token verification is delegated to auth-core's `JwksService`.

Peer dependencies (already present in any NestJS project):
- `@nestjs/common` (^10.0.0 || ^11.0.0)
- `@nestjs/core` (^10.0.0 || ^11.0.0)

## Register the Bridge module

Add `BridgeModule.forRoot()` to your root `AppModule`. The module is `@Global()` — register it once and inject its providers anywhere.

```ts
import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';

@Module({
  imports: [
    BridgeModule.forRoot({ guard: { global: true } }),
    // ... your other modules
  ],
})
export class AppModule {}
```

**Key points:**
- `appId`, `apiBaseUrl` and `debug` are read from `BRIDGE_APP_ID`, `BRIDGE_API_BASE_URL` and `BRIDGE_DEBUG` (`'true'`) when not passed; a value passed to `forRoot()` wins. With no app id either way, startup fails with a clear error naming `BRIDGE_APP_ID`. `forRootAsync` reads only what its factory returns.
- `guard.global: true` registers `BridgeAuthGuard` as an `APP_GUARD`, so it runs on every route automatically.
- `defaultAccess` is `'protected'` unless you say otherwise: any route without a matching rule requires a valid token.
- The module fetches the JWKS and verifies JWTs internally (PS256). User JWTs verify against `{apiBaseUrl}/auth/.well-known/jwks.json`; API tokens against `{apiBaseUrl}/auth/account/app/.well-known/jwks.json`.
- `apiBaseUrl` defaults to `https://api.thebridge.dev`.

**With async configuration** (when the app uses `@nestjs/config`):

```ts
import { ConfigModule, ConfigService } from '@nestjs/config';

BridgeModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    appId: config.get<string>('BRIDGE_APP_ID')!,
    apiBaseUrl: config.get<string>('BRIDGE_API_BASE_URL') || undefined,
    debug: config.get<string>('BRIDGE_DEBUG') === 'true',
    guard: {
      global: true,
      defaultAccess: 'protected',
    },
  }),
}),
```

**Docker / private-network note:** if the container can't reach the public `apiBaseUrl`, override the verification endpoints directly so they resolve over your internal network: `userJwksUrl` for user JWTs (verified against the Bridge JWKS) and `introspectionUrl` for API tokens (verified by POSTing them to the Bridge, since they are HS256-signed with a per-app secret your app never holds).

## Mark public endpoints

Declare public routes in the `rules` array using `privilege: 'ANONYMOUS'`. This keeps route protection visible in one place:

```ts
BridgeModule.forRoot({
  guard: {
    global: true,
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/cards/*', privilege: 'ANONYMOUS' },
      { path: '/webhooks/*', privilege: 'ANONYMOUS' },
    ],
  },
}),
```

**RouteRule schema** (`{ path?, graphqlOperation?, privilege, featureFlag? }`):
- `path` — REST URL wildcard pattern. `*` matches a path segment: `/cards/*` matches `/cards/123`, `/cards/search`, etc.
- `graphqlOperation` — GraphQL operation name (case-sensitive camelCase, e.g. `'listUsers'`). Provide `path`, `graphqlOperation`, or both.
- `privilege` — `'ANONYMOUS'` or `'AUTHENTICATED'` (see below).
- `featureFlag` — optional flag requirement (`'key'`, `{ any: [...] }` or `{ all: [...] }`); the flag's rule says who gets the route. An off flag refuses with 402 `FEATURE_NOT_IN_PLAN` / 403 `FEATURE_NOT_PERMITTED` / 403 `FEATURE_OFF`.

> The rule object carries **`privilege` and `featureFlag`** — and nothing else. There are no `public`, `role`, or `methods` fields: public is `privilege: 'ANONYMOUS'` (or `@Public()`). The older plan-list and entitlement fields were removed; a config that still passes one, or a privilege key such as `'USER_READ'`, fails at startup with an error naming the flag to use instead.

**Alternative:** the `@Public()` decorator marks an individual controller or handler public and overrides any rule. Prefer the centralized `rules` config for consistency, and reach for `@Public()` when you need a single handler on an otherwise-protected path (e.g. a public `GET` next to a protected `POST` on the same route).

Scan the project's controllers to decide what should be public (health checks, public read-only content, webhook receivers) and add those to `rules`. Everything else stays protected by default.

## Privilege levels — RoutePrivilege

```ts
type RoutePrivilege =
  | 'ANONYMOUS'      // no authentication required
  | 'AUTHENTICATED'; // any valid token (user JWT or API token)
```

Anything finer than "signed in" is a flag: `featureFlag` on the rule, ruled on a privilege (`privileges contains "USER_READ"`), a plan feature or a rollout.

```ts
guard: {
  global: true,
  defaultAccess: 'protected',
  rules: [
    { path: '/health', privilege: 'ANONYMOUS' },
    { path: '/api/status', privilege: 'AUTHENTICATED' },
    { path: '/users/*', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },        // rule: privileges contains "USER_READ"
    { path: '/account/subscription/*', privilege: 'AUTHENTICATED', featureFlag: 'manage-billing' }, // rule: privileges contains "TENANT_WRITE"
    { path: '/premium/*', privilege: 'AUTHENTICATED', featureFlag: 'premium' },          // rule: bridge:billing.entitlement.premium eq true
    // GraphQL operations
    { graphqlOperation: 'listUsers', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
    { graphqlOperation: 'deleteUser', privilege: 'AUTHENTICATED', featureFlag: 'delete-users' }, // rule: privileges contains "USER_WRITE"
  ],
}
```

## Access user and tenant context

Use the `@CurrentUser()` and `@CurrentTenant()` parameter decorators to read the verified identity from the request. Both work in HTTP controllers and GraphQL resolvers.

```ts
import { Controller, Get, Post, Body } from '@nestjs/common';
import { CurrentUser, CurrentTenant, BridgeUser, BridgeTenant } from '@nebulr-group/bridge-nestjs';

@Controller('decks')
export class DecksController {
  constructor(private readonly decksService: DecksService) {}

  @Post()
  create(
    @CurrentUser() user: BridgeUser,
    @CurrentTenant() tenant: BridgeTenant,
    @Body() createDeckDto: CreateDeckDto,
  ) {
    return this.decksService.create(createDeckDto, user.id, tenant.id);
  }

  @Get()
  findAll(@CurrentUser() user: BridgeUser) {
    return this.decksService.findByUser(user.id);
  }
}
```

**`BridgeUser` properties** (`transformJwtToBridgeUser` builds this from the verified JWT claims):
- `id` — user ID (from the `sub` claim)
- `email`, `emailVerified`, `username`
- `fullName`, `givenName`, `familyName`, `locale`
- `tenantId` — current tenant/workspace ID
- `appId` — app ID from the token (`aid` claim)
- `role` — user's role in the current tenant (e.g. `'OWNER'`, `'ADMIN'`, `'USER'`); for display — gates are flags
- `privileges` — array of privilege strings (e.g. `['AUTHENTICATED', 'USER_READ']`)
- `onboarded`, `multiTenantAccess`, `scope`

**`BridgeTenant` properties:**
- `id`, `name`, `locale`, `logo`, `onboarded`

## Gate who gets an endpoint — with a flag

Who may call an endpoint is a flag, and the flag's rule says why. Put `@RequireFeatureFlag('…')` on a controller or handler; route-level decorators override controller-level ones (the guard uses NestJS `getAllAndOverride`).

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, RequireFeatureFlag } from '@nebulr-group/bridge-nestjs';

@Controller('admin')
@UseGuards(BridgeAuthGuard)   // omit when guard.global is true
@RequireFeatureFlag('admin-area')          // rule: privileges contains "USER_WRITE"
export class AdminController {
  @Get('dashboard')
  getDashboard() {}

  @Get('settings')
  @RequireFeatureFlag('admin-settings')    // rule: privileges contains "TENANT_WRITE"
  getSettings() {}
}
```

Roles: what a role can do is only true "in the default setup". Read the app's real roles and privileges (`list_roles` / `bridge role list`) before writing a rule. Prefer a privilege rule (`privileges contains "USER_WRITE"`) over a role rule; use a role rule (`user.role eq "ADMIN"`) only when the developer means the role itself. Privilege `contains` is exact membership.

## API tokens and dual auth

The guard accepts two token types: a user JWT via `Authorization: Bearer <token>`, and a server-to-server API token via the `x-api-key` header. When an API token is verified its claims are attached to `req.bridgeApiToken` (`ApiTokenClaims` re-exported from auth-core).

- `@RequirePrivilege('USER_READ')` — the scope an **API token** must carry. API tokens only: a signed-in user is not checked against it (gate people with a flag).
- `@AcceptAuth('jwt' | 'api_token' | 'both')` — restrict which token type a route accepts. Default is `'both'`.

```ts
import { Controller, Post, Req } from '@nestjs/common';
import { AcceptAuth, RequirePrivilege } from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';

@Controller('integrations')
export class IntegrationsController {
  @Post('sync')
  @AcceptAuth('api_token')      // user JWTs get 401 here
  @RequirePrivilege('TENANT_WRITE')
  syncData(@Req() req: Request) {
    const { tenantId } = req.bridgeApiToken!;
    return this.syncService.run(tenantId);
  }
}
```

See **auth-prompt.md** for the full token-verification, privilege, and access-control story.

## Feature flags

Feature flags gate behavior behind a switch you control from the Bridge dashboard, no redeploy required. There are two ways to check flags — pick by whether you need live updates. `@RequireFlag` / `BridgeFlagsService` (from `@nebulr-group/bridge-nestjs/flags`) evaluate against a local client that can subscribe to live updates and can also read a flag value. `@RequireFeatureFlag` / `FeatureFlagService` (from the package root) evaluate on demand over the Bridge API with a short cache and no live updates — good for simple route gating without running a flags client. See **feature-flags-prompt.md** for setup and both paths in detail.

## Billing and entitlements

Read tenant data (subscription, branding) with `BridgeService.fromRequest(req)` (behind `BridgeAuthGuard`). A feature a plan sells is a flag ruled `bridge:billing.entitlement.<feature> eq true`, asked with `@RequireFeatureFlag` or a rule's `featureFlag`. Plan limits are one decorator on the handler — `@RequireQuota` / `@SyncQuota`. A backend plugin never runs checkout — purchasing lives in the frontend plugin. See **billing-prompt.md**.

## Environment variables

```env
BRIDGE_APP_ID=your-app-id-here
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `BRIDGE_APP_ID` | Yes | — | Your Bridge application ID |
| `BRIDGE_API_BASE_URL` | For a stage, local or self-hosted app | `https://api.thebridge.dev` (production) | Bridge API base URL |
| `BRIDGE_DEBUG` | No | `false` | Enable debug logging |

## Verify the integration

1. **Build check:** run the project's build command — no TypeScript or import errors.
2. **Start check:** start the dev server — the app bootstraps cleanly.
3. **Public endpoint:** `curl http://localhost:{port}/health` (or a `@Public()` route) returns 200.
4. **Protected endpoint, no token:** `curl http://localhost:{port}/decks` returns 401.
5. **Protected endpoint, valid token:** send a request with a valid `Authorization: Bearer <token>` header — returns 200 with data scoped to that user's tenant.
6. **Gates:** `npx @nebulr-group/bridge-cli check gates` reports nothing — every gate is a flag.
