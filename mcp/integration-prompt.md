# Bridge NestJS Integration

You are integrating The Bridge into a NestJS application. This adds JWT-based authentication, tenant context, role and privilege access control, and feature flags to your API.

This is a **backend** integration: there are no UI components, no login screen, and no checkout redirect. The frontend (a Bridge frontend plugin — svelte/react/nextjs/angular) handles login and obtains the user's access token; this plugin verifies that token on every request and exposes the verified identity to your controllers and resolvers.

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

`@nebulr-group/bridge-auth-core` is pulled in automatically as a transitive dependency — do **not** install it directly. All JWT and API-token verification is delegated to auth-core's `JwksService`; this plugin does no local `jose` verification of its own.

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
    BridgeModule.forRoot({
      appId: process.env.BRIDGE_APP_ID!,
      guard: {
        global: true,
        defaultAccess: 'protected',
      },
    }),
    // ... your other modules
  ],
})
export class AppModule {}
```

**Key points:**
- `guard.global: true` registers `BridgeAuthGuard` as an `APP_GUARD`, so it runs on every route automatically.
- `defaultAccess: 'protected'` means any route without a matching rule requires a valid token.
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

**Docker / private-network note:** if the container can't reach the public `apiBaseUrl`, override the JWKS URLs directly with `apiTokenJwksUrl` and `userJwksUrl` so verification keys resolve over your internal network.

## Mark public endpoints

Declare public routes in the `rules` array using `privilege: 'ANONYMOUS'`. This keeps route protection visible in one place:

```ts
BridgeModule.forRoot({
  appId: process.env.BRIDGE_APP_ID!,
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

**RouteRule schema** (`{ path?, graphqlOperation?, privilege, plans? }`):
- `path` — REST URL wildcard pattern. `*` matches a path segment: `/cards/*` matches `/cards/123`, `/cards/search`, etc.
- `graphqlOperation` — GraphQL operation name (case-sensitive camelCase, e.g. `'listUsers'`). Provide `path`, `graphqlOperation`, or both.
- `privilege` — the required `RoutePrivilege` (see below).
- `plans` — optional plan restriction; the tenant's subscription plan must be in this list.

> The rule object carries **privilege and plan only**. There are no `public`, `role`, `featureFlag`, or `methods` fields — role gating is done with `@RequireRole`, flag gating with `@RequireFlag` / `@RequireFeatureFlag`, on the controller or handler.

**Alternative:** the `@Public()` decorator marks an individual controller or handler public and overrides any rule. Prefer the centralized `rules` config for consistency, and reach for `@Public()` when you need a single handler on an otherwise-protected path (e.g. a public `GET` next to a protected `POST` on the same route).

Scan the project's controllers to decide what should be public (health checks, public read-only content, webhook receivers) and add those to `rules`. Everything else stays protected by default.

## Privilege levels — RoutePrivilege

```ts
type RoutePrivilege =
  | 'ANONYMOUS'      // no authentication required
  | 'AUTHENTICATED'  // any valid token (user JWT or API token)
  | 'USER_READ'      // requires USER_READ in the JWT privileges claim
  | 'USER_WRITE'
  | 'TENANT_READ'
  | 'TENANT_WRITE'
  | string;          // any custom privilege string
```

```ts
guard: {
  global: true,
  defaultAccess: 'protected',
  rules: [
    { path: '/health', privilege: 'ANONYMOUS' },
    { path: '/api/status', privilege: 'AUTHENTICATED' },
    { path: '/users/*', privilege: 'USER_READ' },
    { path: '/account/subscription/*', privilege: 'TENANT_WRITE' },
    { path: '/premium/*', privilege: 'AUTHENTICATED', plans: ['PREMIUM', 'ENTERPRISE'] },
    // GraphQL operations
    { graphqlOperation: 'listUsers', privilege: 'USER_READ' },
    { graphqlOperation: 'deleteUser', privilege: 'USER_WRITE' },
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
- `role` — user's role in the current tenant (e.g. `'OWNER'`, `'ADMIN'`, `'USER'`)
- `privileges` — array of privilege strings (e.g. `['AUTHENTICATED', 'USER_READ']`)
- `onboarded`, `multiTenantAccess`, `scope`

**`BridgeTenant` properties:**
- `id`, `name`, `locale`, `logo`, `onboarded`

## Role-based access control

Use `@RequireRole()` to restrict a controller or handler to a role. Route-level decorators override controller-level ones (the guard uses NestJS `getAllAndOverride`).

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, RequireRole } from '@nebulr-group/bridge-nestjs';

@Controller('admin')
@UseGuards(BridgeAuthGuard)   // omit when guard.global is true
@RequireRole('ADMIN')
export class AdminController {
  @Get('dashboard')
  getDashboard() {}

  @Get('settings')
  @RequireRole('OWNER')  // overrides the controller-level ADMIN
  getSettings() {}
}
```

> Roles are **decorator-only** — they are not expressible in route rules.

## API tokens and dual auth

The guard accepts two token types: a user JWT via `Authorization: Bearer <token>`, and a server-to-server API token via the `x-api-key` header. When an API token is verified its claims are attached to `req.bridgeApiToken` (`ApiTokenClaims` re-exported from auth-core).

- `@RequirePrivilege('USER_READ')` — enforce a privilege on **API tokens**. User JWTs bypass this check for backward compatibility.
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

Read tenant data (subscription, entitlements, branding) with `BridgeService` and gate features server-side via `BridgeService.fromJwt(jwt)` or the `plans` field on a route rule. A backend plugin never runs checkout — purchasing lives in the frontend plugin. See **billing-prompt.md**.

## Environment variables

```env
BRIDGE_APP_ID=your-app-id-here
```

| Variable | Required | Default | Description |
|---|---|---|---|
| `BRIDGE_APP_ID` | Yes | — | Your Bridge application ID |
| `BRIDGE_API_BASE_URL` | No | `https://api.thebridge.dev` | Bridge API base URL |
| `BRIDGE_DEBUG` | No | `false` | Enable debug logging |

## Verify the integration

1. **Build check:** run the project's build command — no TypeScript or import errors.
2. **Start check:** start the dev server — the app bootstraps cleanly.
3. **Public endpoint:** `curl http://localhost:{port}/health` (or a `@Public()` route) returns 200.
4. **Protected endpoint, no token:** `curl http://localhost:{port}/decks` returns 401.
5. **Protected endpoint, valid token:** send a request with a valid `Authorization: Bearer <token>` header — returns 200 with data scoped to that user's tenant.
