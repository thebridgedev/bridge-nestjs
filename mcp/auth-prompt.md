# Bridge NestJS — Authentication & Access Control

You are wiring **backend authentication and access control** into a NestJS application that uses The Bridge. This is the server-side analog of the frontend "SDK auth" guide: there is no login screen and no token issuance here. The frontend obtains the user's access token; this plugin **verifies** that token on every request, attaches the verified identity to the request, and gates handlers by privilege, role, and auth type.

All JWT and API-token verification is delegated to `@nebulr-group/bridge-auth-core/backend` (`JwksService`). The plugin does no local `jose` verification — it fetches the JWKS, verifies the signature (PS256), checks issuer/audience, and transforms the claims into `BridgeUser` / `ApiTokenClaims`.

## Prerequisites

Verify Bridge is set up in this project:

1. `@nebulr-group/bridge-nestjs` is in `package.json` dependencies.
2. `BridgeModule.forRoot()` (or `forRootAsync`) is registered in the root `AppModule`.
3. `BRIDGE_APP_ID` is set in the environment.

If any are missing, run the integration guide (`integration-prompt.md`) first.

## Two token types

| Type | Header | Verified against | Attached to request | Typical use |
|---|---|---|---|---|
| User JWT | `Authorization: Bearer <jwt>` | `{apiBaseUrl}/auth/.well-known/jwks.json` | `req.bridgeUser`, `req.bridgeTenant` | Browser users via a frontend plugin |
| API token | `x-api-key: <jwt>` | `{apiBaseUrl}/auth/account/app/.well-known/jwks.json` | `req.bridgeApiToken` | Server-to-server, programmatic access |

`BridgeAuthGuard` inspects both headers. When an API token is present it is verified and its claims land on `req.bridgeApiToken`. When only a Bearer token is present it follows the user-JWT path. By default a route accepts **either**.

## Step 1 — Choose how the guard runs

**Global guard (recommended).** Set `guard.global: true` in `BridgeModule.forRoot()` and the guard runs on every route automatically. Mark exceptions with `@Public()` or `privilege: 'ANONYMOUS'` rules.

```ts
BridgeModule.forRoot({
  appId: process.env.BRIDGE_APP_ID!,
  guard: {
    global: true,
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/webhooks/*', privilege: 'ANONYMOUS' },
    ],
  },
}),
```

**Per-controller / per-route guard.** If you prefer not to run globally, apply `@UseGuards(BridgeAuthGuard)` to the controllers or handlers that need protection:

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('items')
@UseGuards(BridgeAuthGuard)
export class ItemsController {
  @Get()
  findAll(@CurrentUser() user: BridgeUser) {
    return { user: user.email };
  }
}
```

The examples below assume the guard is active (global or via `@UseGuards`).

## Step 2 — Read the authenticated user

`@CurrentUser()` returns the verified `BridgeUser`; `@CurrentTenant()` returns the `BridgeTenant`. Both are parameter decorators and work in HTTP controllers and GraphQL resolvers.

```ts
import { Controller, Get } from '@nestjs/common';
import { CurrentUser, CurrentTenant, BridgeUser, BridgeTenant } from '@nebulr-group/bridge-nestjs';

@Controller('users')
export class UsersController {
  @Get('me')
  me(@CurrentUser() user: BridgeUser, @CurrentTenant() tenant: BridgeTenant) {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      privileges: user.privileges,
      tenant: { id: tenant.id, name: tenant.name },
    };
  }
}
```

`BridgeUser`: `id`, `email`, `emailVerified`, `username`, `fullName`, `givenName?`, `familyName?`, `locale?`, `onboarded?`, `tenantId`, `appId?`, `scope?`, `role?`, `multiTenantAccess?`, `privileges?`.

`BridgeTenant`: `id`, `name`, `locale?`, `logo?`, `onboarded?`.

**Always scope queries to the verified `tenantId`.** A user's token is only ever valid for their current tenant; never accept a tenant ID from the request body and trust it.

## Step 3 — Gate by role

```ts
import { Controller, Get } from '@nestjs/common';
import { RequireRole } from '@nebulr-group/bridge-nestjs';

@Controller('admin')
@RequireRole('ADMIN')          // controller default
export class AdminController {
  @Get('dashboard')
  dashboard() {}

  @Get('settings')
  @RequireRole('OWNER')        // route override — most specific decorator wins
  settings() {}
}
```

Roles are decorator-only — there is no `role` field on route rules.

## Step 4 — Gate API tokens by privilege

`@RequirePrivilege(key)` enforces that the **API token** carries a privilege in its `privileges` claim. User JWTs **bypass** this check for backward compatibility, so an endpoint can require `USER_WRITE` for API-token callers while still serving browser users.

```ts
import { Controller, Get, Post } from '@nestjs/common';
import { RequirePrivilege } from '@nebulr-group/bridge-nestjs';

@Controller('users')
export class UsersController {
  @Get()
  @RequirePrivilege('USER_READ')
  list() {}

  @Post()
  @RequirePrivilege('USER_WRITE')
  create() {}
}
```

`ApiTokenClaims` (re-exported from auth-core via `@nebulr-group/bridge-nestjs`):

```ts
interface ApiTokenClaims {
  sub: string;               // token subject
  appId: string;             // app the token was issued for
  tenantId: string | null;   // null for app-level tokens
  type: 'api';
  privileges: string[];
}
```

## Step 5 — Restrict the accepted auth type

`@AcceptAuth('jwt' | 'api_token' | 'both')` controls which credential a route accepts. Omitting the decorator is equivalent to `'both'`.

```ts
import { Controller, Get, Post, Req } from '@nestjs/common';
import { AcceptAuth, RequirePrivilege, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';

@Controller('account')
export class AccountController {
  // User-only — an API token (x-api-key) gets 401.
  @Get('profile')
  @AcceptAuth('jwt')
  profile(@CurrentUser() user: BridgeUser) {
    return { email: user.email, role: user.role };
  }
}

@Controller('integrations')
export class IntegrationsController {
  // API-token-only — a user Bearer token gets 401.
  @Post('sync')
  @AcceptAuth('api_token')
  @RequirePrivilege('TENANT_WRITE')
  sync(@Req() req: Request) {
    const { tenantId } = req.bridgeApiToken!;
    return this.syncService.run(tenantId);
  }
}
```

**Dual-auth handler** (default — branch on `req.bridgeApiToken`):

```ts
@Get()
@RequirePrivilege('USER_READ')
list(@CurrentUser() user: BridgeUser, @Req() req: Request) {
  if (req.bridgeApiToken) {
    // server-to-server: tenant comes from the API token
    return this.usersService.findByTenant(req.bridgeApiToken.tenantId!);
  }
  // browser user: tenant comes from the JWT
  return this.usersService.findByTenant(user.tenantId);
}
```

## Step 6 — Mark public exceptions

`@Public()` overrides any guard or rule and skips authentication for a handler — useful for a public `GET` beside a protected `POST` on the same path:

```ts
import { Controller, Get } from '@nestjs/common';
import { Public } from '@nebulr-group/bridge-nestjs';

@Controller()
export class AppController {
  @Get('health')
  @Public()
  health() {
    return { status: 'ok' };
  }
}
```

Prefer the centralized `rules` config (`privilege: 'ANONYMOUS'`) for whole paths, and reserve `@Public()` for per-handler exceptions.

## Verifying a token manually (advanced)

For non-guard contexts — a custom middleware, a Centrifugo/WebSocket auth hook, a queue consumer — inject `JwksService` and verify directly. Wrap calls in a `TokenVerificationError` check.

```ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwksService, TokenVerificationError } from '@nebulr-group/bridge-nestjs';

@Injectable()
export class SocketAuthService {
  constructor(private readonly jwks: JwksService) {}

  async authenticate(bearer: string) {
    try {
      const claims = await this.jwks.verifyToken(bearer);   // user JWT
      return claims;
    } catch (e) {
      if (e instanceof TokenVerificationError) {
        throw new UnauthorizedException('Invalid token');
      }
      throw e;
    }
  }

  async authenticateApiToken(apiKey: string) {
    // expectedAppId guards against tokens minted for a different app
    return this.jwks.verifyApiToken(apiKey, process.env.BRIDGE_APP_ID!);
  }
}
```

`TokenVerificationError` is the **same class** the guard throws — `instanceof` checks behave identically regardless of which path raised it.

## Access-control checklist

- [ ] `BridgeModule.forRoot()` registered with `guard.global: true` (or `@UseGuards(BridgeAuthGuard)` on protected controllers)
- [ ] `defaultAccess: 'protected'` so unmatched routes require a token
- [ ] Public routes declared with `privilege: 'ANONYMOUS'` rules (or `@Public()` per-handler)
- [ ] Handlers read identity via `@CurrentUser()` / `@CurrentTenant()`, never trust a tenant ID from the body
- [ ] Role-gated routes use `@RequireRole()` (decorator-only)
- [ ] API-token privilege enforcement via `@RequirePrivilege()` where server-to-server access applies
- [ ] `@AcceptAuth()` set on routes that must reject one credential type
- [ ] Manual verification (if any) goes through `JwksService` + `TokenVerificationError`

## Verify

1. **Build:** the project builds with no TypeScript or import errors.
2. **No token → 401:** a protected route without a credential returns 401.
3. **Valid JWT → 200:** a protected route with a valid `Authorization: Bearer` returns 200 scoped to the JWT's tenant.
4. **Role gate:** a `@RequireRole('OWNER')` route returns 403 for a non-owner JWT.
5. **Privilege gate:** an `@AcceptAuth('api_token')` + `@RequirePrivilege('TENANT_WRITE')` route returns 200 for an API token carrying `TENANT_WRITE`, 401 for a user Bearer token, and 403 for an API token missing the privilege.
6. **Auth-type restriction:** an `@AcceptAuth('jwt')` route returns 401 when called with `x-api-key`.
