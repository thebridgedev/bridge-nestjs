# Bridge NestJS — Authentication & Access Control

You are wiring **backend authentication and access control** into a NestJS application that uses The Bridge. This is the server-side analog of the frontend "SDK auth" guide: there is no login screen and no token issuance here. The frontend obtains the user's access token; this plugin **verifies** that token on every request, attaches the verified identity to the request, and gates handlers by flag, API-token scope and auth type.

All JWT and API-token verification is delegated to `@nebulr-group/bridge-auth-core/backend` (`JwksService`). The plugin does no local `jose` verification — it fetches the JWKS, verifies the signature (PS256), checks issuer/audience, and transforms the claims into `BridgeUser` / `ApiTokenClaims`.

## The one rule for app code

**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains "USER_WRITE"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.

Two things are not gates and are not flags: **numbers** are plan limits (`<QuotaGate>` in the browser, `@RequireQuota` on the backend), and **permission on one specific record** stays in app code ("only the author edits their post").

Before calling the work done, run `npx @nebulr-group/bridge-cli check gates` in the project. It lists every direct role, privilege, plan or plan-feature check with the flag to use instead. Fix each one.

In NestJS, an endpoint is `@RequireFeatureFlag('…')` on the handler (or a route rule with `featureFlag`).

Roles: what a role can do is only true "in the default setup". Read the app's real roles and privileges (`list_roles` / `bridge role list`) before writing a rule. Prefer a privilege rule (`privileges contains "USER_WRITE"`) over a role rule; use a role rule (`user.role eq "ADMIN"`) only when the developer means the role itself. Privilege `contains` is exact membership.

## Decide first — which check do you need?

Every gate below is **declarative**: a guard plus decorators, not logic inside the handler. They are not interchangeable, and picking the wrong one usually fails open rather than loudly.

| The question you are asking | The check | Denial |
|---|---|---|
| Is this caller authenticated at all? | `BridgeAuthGuard` — globally via `guard.global: true`, or `@UseGuards(BridgeAuthGuard)` | 401 |
| Which credential may call this route? | `@AcceptAuth('jwt')` / `@AcceptAuth('api_token')` — default accepts both | 401 |
| Who may use this endpoint (a privilege, a plan feature, a rollout)? | `@RequireFeatureFlag('…')`, or `featureFlag` on a route rule — the flag's rule says why | 402 `FEATURE_NOT_IN_PLAN` / 403 `FEATURE_NOT_PERMITTED` / 403 `FEATURE_OFF` |
| Does an **API token** hold a scope? | `@RequirePrivilege('…')` — API tokens only | 403 |
| Is the tenant under its plan limit for the thing this handler creates? | `@RequireQuota('…')` (+ `@SyncQuota` on the delete) — see `billing-prompt.md` | 402 `QUOTA_EXCEEDED` |
| Should this one handler skip auth? | `@Public()`, or a `privilege: 'ANONYMOUS'` rule | — |
| I am outside a request — socket hook, queue consumer, middleware | `JwksService.verifyToken` / `.verifyApiToken` directly | `TokenVerificationError` |

Two of these fail open, which is why this table comes before the steps:

- **`@RequirePrivilege` is API tokens only.** It is the scope a machine caller (x-api-key) must carry; a signed-in user is not checked against it (Step 4). If you meant "this user may not do this", you want `@RequireFeatureFlag('…')` with the flag ruled `privileges contains "<PRIVILEGE>"` — this decorator lets every signed-in user straight through.
- **Every decorator here is inert without the guard.** `@RequireFeatureFlag`, `@RequirePrivilege` and `@AcceptAuth` only set metadata that `BridgeAuthGuard` reads. On a route the guard never runs on they are decoration, and the route is unprotected while looking protected. (`@RequireQuota` is the one that fails closed: with no user verified by the guard it answers 401 — which on a `@Public()` route means it refuses everyone.)

If the user has not said which credential a route serves, ask. It changes the decorators *and* where the handler reads the tenant from.

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
  // appId comes from BRIDGE_APP_ID when omitted
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

Rule paths are the full request path, **including a global prefix**: with `app.setGlobalPrefix('api')` the health check is `/api/health`, so the rule is `{ path: '/api/health', … }`. A rule written without the prefix never matches (the plugin warns once at the first such request). For a single endpoint, `@Public()` on the handler avoids the question entirely.

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

## Step 3 — Gate who gets an endpoint with a flag

Who may call an endpoint is a flag. Create the flag, give it a rule on the privilege the endpoint needs, and put the flag on the handler:

```ts
import { Controller, Get } from '@nestjs/common';
import { RequireFeatureFlag } from '@nebulr-group/bridge-nestjs';

@Controller('admin')
@RequireFeatureFlag('admin-area')        // rule: privileges contains "USER_WRITE"
export class AdminController {
  @Get('dashboard')
  dashboard() {}

  @Get('settings')
  @RequireFeatureFlag('admin-settings')  // rule: privileges contains "TENANT_WRITE" — most specific decorator wins
  settings() {}
}
```

In the default setup ADMIN and OWNER hold `USER_WRITE` and only OWNER holds `TENANT_WRITE`; read the app's real roles with `list_roles` / `bridge role list` before writing the rule. Changing who gets the endpoint is then a rule change, not a release. The same flag can sit on a route rule instead: `{ path: '/admin/*', privilege: 'AUTHENTICATED', featureFlag: 'admin-area' }`. See `feature-flags-prompt.md` for creating flags and rules.

## Step 4 — Scope API tokens with `@RequirePrivilege` (API tokens only)

`@RequirePrivilege(key)` enforces that the **API token** (x-api-key, a machine caller) carries a privilege in its `privileges` claim. It is a token scope, not a gate on a person: a signed-in user is not checked against it, so an endpoint can require `USER_WRITE` from API-token callers while signed-in users are gated by the endpoint's flag.

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

Prefer `@Public()` on the handler: it follows the route wherever it is mounted, global prefix included. Use a rule (`privilege: 'ANONYMOUS'`) for a whole group of paths you do not own as handlers, such as `/api/webhooks/*`, and write it with the full path.

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
- [ ] Who gets an endpoint is a flag: `@RequireFeatureFlag('…')` (or `featureFlag` on a route rule), ruled on a privilege, a plan feature or a rollout — never a role or plan read in the handler
- [ ] Route rules use only `privilege: 'ANONYMOUS'` / `'AUTHENTICATED'` (anything else throws at startup)
- [ ] `npx @nebulr-group/bridge-cli check gates` reports nothing
- [ ] API-token privilege enforcement via `@RequirePrivilege()` where server-to-server access applies
- [ ] `@AcceptAuth()` set on routes that must reject one credential type
- [ ] Manual verification (if any) goes through `JwksService` + `TokenVerificationError`

## Verify

1. **Build:** the project builds with no TypeScript or import errors.
2. **No token → 401:** a protected route without a credential returns 401.
3. **Valid JWT → 200:** a protected route with a valid `Authorization: Bearer` returns 200 scoped to the JWT's tenant.
4. **Flag gate:** a `@RequireFeatureFlag('admin-settings')` route returns 403 `FEATURE_NOT_PERMITTED` / `FEATURE_OFF` for a JWT the flag is off for, and 200 once the flag's rule matches that user.
5. **Privilege gate:** an `@AcceptAuth('api_token')` + `@RequirePrivilege('TENANT_WRITE')` route returns 200 for an API token carrying `TENANT_WRITE`, 401 for a user Bearer token, and 403 for an API token missing the privilege.
6. **Auth-type restriction:** an `@AcceptAuth('jwt')` route returns 401 when called with `x-api-key`.
