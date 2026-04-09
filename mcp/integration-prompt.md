# Bridge NestJS Integration

You are integrating The Bridge into a NestJS application. This adds JWT-based authentication, tenant context, role-based access control, and feature flags to your API.

## Prerequisites

- **appId** — your Bridge application ID. Get it from `bridge app get` or the Bridge dashboard.
- **Package manager** — use whatever the project already uses (check for `bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, or `package-lock.json`).

## Migration check

Before starting, check if the project has existing auth:

**Migrating from `@nebulr/nblocks-nestjs` or custom nblocks integration:**

| Old (nblocks) | New (bridge-nestjs) |
|---|---|
| `@nebulr/nblocks-nestjs` or custom JWT guards | `@nebulr-group/bridge-nestjs` package |
| Custom `AuthGuard` with manual JWKS | `BridgeAuthGuard` (built-in JWKS handling) |
| Custom `@User()` decorator | `@CurrentUser()` decorator |
| Manual tenant extraction from JWT | `@CurrentTenant()` decorator |
| `NBLOCKS_APP_ID` env var | `BRIDGE_APP_ID` env var |

**Migration steps:**
1. Remove old auth packages and custom guard/decorator files
2. Install bridge-nestjs (see Install section)
3. Replace `AppModule` auth module imports with `BridgeModule.forRoot()`
4. Replace custom decorators with Bridge equivalents
5. Update environment variables

**If no existing auth is found:** skip migration steps, proceed directly to Install.

## Install

```bash
{pm} add @nebulr-group/bridge-nestjs
```

Replace `{pm}` with the project's package manager (`bun add`, `pnpm add`, `yarn add`, or `npm i`).

Peer dependencies (should already be in a NestJS project):
- `@nestjs/common` (^10.0.0 || ^11.0.0)
- `@nestjs/core` (^10.0.0 || ^11.0.0)

## Register the Bridge module

Add `BridgeModule.forRoot()` to your root `AppModule`:

```ts
import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';

@Module({
  imports: [
    BridgeModule.forRoot({
      appId: process.env.BRIDGE_APP_ID,
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
- `guard.global: true` applies the auth guard to all routes automatically.
- `defaultAccess: 'protected'` means all endpoints require a valid JWT by default.
- The module handles JWKS fetching and JWT verification internally (PS256 algorithm).

**With async configuration** (if you use NestJS ConfigModule):

```ts
BridgeModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    appId: config.get('BRIDGE_APP_ID'),
    guard: {
      global: true,
      defaultAccess: 'protected',
    },
  }),
}),
```

## Mark public endpoints

Define public routes in the `rules` array of the guard config. Use `privilege: 'ANONYMOUS'` to allow unauthenticated access. This keeps all route protection visible in one place:

```ts
BridgeModule.forRoot({
  appId: process.env.BRIDGE_APP_ID,
  guard: {
    global: true,
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/cards/*', privilege: 'ANONYMOUS' },
      { path: '/cards/search/*', privilege: 'ANONYMOUS' },
    ],
  },
}),
```

**Wildcard matching:** `*` matches any path segment. `/cards/*` matches `/cards/123`, `/cards/search`, etc.

Scan the project's controllers to identify which endpoints should be public (read-only content, health checks, webhooks) and add them to the rules array. Everything else is protected by default.

**Alternative:** The `@Public()` decorator can also be used on individual controllers or methods if you prefer co-locating the access rule with the code. But prefer the centralized config approach for consistency.

## Access user and tenant context

Use the `@CurrentUser()` and `@CurrentTenant()` decorators to extract identity from the JWT:

```ts
import { Controller, Get, Post, Body } from '@nestjs/common';
import { CurrentUser, CurrentTenant, BridgeUser, BridgeTenant } from '@nebulr-group/bridge-nestjs';

@Controller('decks')
export class DecksController {
  @Post()
  create(
    @CurrentUser() user: BridgeUser,
    @CurrentTenant() tenant: BridgeTenant,
    @Body() createDeckDto: CreateDeckDto,
  ) {
    // user.id — the authenticated user's ID
    // user.email — user's email
    // user.role — user's role in the tenant
    // tenant.id — the tenant/workspace ID
    return this.decksService.create(createDeckDto, user.id, tenant.id);
  }

  @Get()
  findAll(@CurrentUser() user: BridgeUser) {
    // Return only this user's decks
    return this.decksService.findByUser(user.id);
  }
}
```

**BridgeUser properties:**
- `id` — User ID (from JWT `sub` claim)
- `email` — User's email
- `role` — User's role in the current tenant (e.g., `'OWNER'`, `'ADMIN'`, `'USER'`)
- `tenantId` — Current tenant ID
- `privileges` — Array of privilege strings
- `fullName`, `givenName`, `familyName` — Name fields
- `onboarded` — Whether the user has completed onboarding

**BridgeTenant properties:**
- `id` — Tenant ID
- `name` — Tenant name
- `locale` — Tenant locale
- `logo` — Tenant logo URL

## Role-based access control

Use `@RequireRole()` to restrict endpoints to specific roles:

```ts
import { RequireRole } from '@nebulr-group/bridge-nestjs';

@Controller('admin')
@RequireRole('OWNER')
export class AdminController {
  @Get('settings')
  getSettings() {
    // Only OWNER role can access
  }

  @Get('stats')
  @RequireRole('ADMIN')  // Override: ADMIN or above
  getStats() {}
}
```

## Feature flag gating

Use `@RequireFeatureFlag()` to gate endpoints behind feature flags:

```ts
import { RequireFeatureFlag } from '@nebulr-group/bridge-nestjs';

@Get('beta')
@RequireFeatureFlag('beta-access')
getBetaFeature() {
  // Only accessible if user has 'beta-access' flag enabled
}

@Get('premium')
@RequireFeatureFlag({ all: ['premium-tier', 'active-subscription'] })
getPremiumFeature() {
  // Requires ALL listed flags
}
```

## Environment variables

Add to your `.env` file:

```env
BRIDGE_APP_ID=your-app-id-here
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BRIDGE_APP_ID` | Yes | — | Your Bridge application ID |
| `BRIDGE_DEBUG` | No | `false` | Enable debug logging |

## Endpoint protection defaults

When deciding which endpoints to protect:

- **Public (`privilege: 'ANONYMOUS'` in rules):** health checks, public read-only content (card catalog, product listings, search), webhook receivers
- **Protected (default):** any endpoint that creates, modifies, or deletes user-specific data
- **Role-gated (`@RequireRole()` decorator):** admin panels, tenant management, user management

**Typical rules config for a project with mixed access:**

```ts
guard: {
  global: true,
  defaultAccess: 'protected',
  rules: [
    // Public read-only endpoints
    { path: '/items', privilege: 'ANONYMOUS' },
    { path: '/items/*', privilege: 'ANONYMOUS' },
    { path: '/health', privilege: 'ANONYMOUS' },
    // Everything else (POST/PUT/DELETE) is protected by default
  ],
}
```

Note: GET and POST/PUT/DELETE on the same path share the same rule. If you need fine-grained control (GET public, POST protected on the same path), use the `@Public()` decorator on the specific GET handler instead of a rule.

## Verify the integration

After completing the setup:

1. **Build check:** Run the project's build command. There should be no TypeScript or import errors.
2. **Start check:** Start the dev server. The app should bootstrap without errors and log `BridgeModule initialized`.
3. **Public endpoint check:** `curl http://localhost:{port}/health` (or a `@Public()` endpoint) — should return 200.
4. **Protected endpoint check:** `curl http://localhost:{port}/decks` (a protected endpoint without auth header) — should return 401 with `WWW-Authenticate` header.
5. **Auth check:** Send a request with a valid Bearer token to a protected endpoint — should return 200 with data.
