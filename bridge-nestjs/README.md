# @nebulr-group/bridge-nestjs

Bridge NestJS plugin for authentication, access control, feature flags, and tenant data (subscription, entitlements, branding).

Built on [`@nebulr-group/bridge-auth-core`](https://www.npmjs.com/package/@nebulr-group/bridge-auth-core) — all JWT and API-token verification is delegated to auth-core's framework-agnostic `JwksService`. This plugin adds the NestJS dependency-injection layer: a module, a guard, decorators, and the request-scoped `BridgeService`.

## Installation

```bash
npm install @nebulr-group/bridge-nestjs
```

`@nebulr-group/bridge-auth-core` is pulled in as a transitive dependency — you do not install it directly.

## Quick Start

### Basic Setup

```typescript
import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';

@Module({
  imports: [
    BridgeModule.forRoot({
      appId: 'your-app-id',
    }),
  ],
})
export class AppModule {}
```

### Global Guard with Route Rules

Central rules express **privilege** and **plan** requirements. Role gating uses `@RequireRole`, and
feature-flag gating uses `@RequireFeatureFlag` / `@RequireFlag` on the controller or route.

```typescript
BridgeModule.forRoot({
  appId: 'your-app-id',
  guard: {
    global: true,
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/account/users', privilege: 'USER_READ' },
      { path: '/reports/*', privilege: 'TENANT_READ', plans: ['pro', 'enterprise'] },
      { graphqlOperation: 'listUsers', privilege: 'USER_READ' },
    ],
  },
})
```

### Async Configuration

```typescript
import { ConfigModule, ConfigService } from '@nestjs/config';

BridgeModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    appId: config.get('BRIDGE_APP_ID'),
    debug: config.get('BRIDGE_DEBUG') === 'true',
  }),
})
```

## Usage

### Protected Routes

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('items')
@UseGuards(BridgeAuthGuard)
export class ItemsController {
  @Get()
  findAll(@CurrentUser() user: BridgeUser) {
    return this.itemsService.findByTenant(user.tenantId);
  }
}
```

### Role-Based Access

```typescript
import { RequireRole } from '@nebulr-group/bridge-nestjs';

@Controller('admin')
@UseGuards(BridgeAuthGuard)
@RequireRole('ADMIN')
export class AdminController {
  @Get('settings')
  @RequireRole('OWNER') // Override controller-level role
  getSettings() { ... }
}
```

### Privilege-Based Access (API tokens)

`@RequirePrivilege` gates a route on an API-token privilege. It is enforced by `BridgeAuthGuard` when a
request authenticates with an API token (`x-api-key`). User JWTs (`Authorization: Bearer`) bypass this
check for backward compatibility — use `@RequireRole` to gate user JWTs.

```typescript
import { RequirePrivilege } from '@nebulr-group/bridge-nestjs';

@Controller('users')
@UseGuards(BridgeAuthGuard)
export class UsersController {
  @Get()
  @RequirePrivilege('USER_READ')
  listUsers() { ... }
}
```

### Restricting Accepted Auth Types

`@AcceptAuth` restricts which authentication type an endpoint accepts:

- `'jwt'` — only user JWT (`Authorization: Bearer`); an `x-api-key` request gets 401
- `'api_token'` — only API token (`x-api-key`); a Bearer request gets 401
- `'both'` — either type (the default when the decorator is omitted)

```typescript
import { AcceptAuth } from '@nebulr-group/bridge-nestjs';

@Controller('account/api-token/me')
@AcceptAuth('jwt')
@UseGuards(BridgeAuthGuard)
export class ApiTokenUserController { ... }
```

### Feature Flags

There are two ways to check flags — pick by whether you need live updates.

**`@RequireFlag` / `@Flag`** — backed by the `BridgeFlags` client, which can subscribe to **live updates**;
`@Flag` also injects a flag's value into a handler param. Use this when you want live updates or need to
read a flag value (not just gate). See the
[Feature Flags guide](../learning/feature-flags/feature-flags.md) for setup (`BridgeFlagsModule`,
`BridgeFlagGuard`, `BridgeContextInterceptor`).

```typescript
import { RequireFlag, Flag } from '@nebulr-group/bridge-nestjs/flags';

@Get('beta')
@RequireFlag('beta_access')           // 403 when the flag is off
getBeta() { ... }

@Get('home')
home(@Flag({ key: 'show_new_home', defaultValue: false }) showNew: boolean) {
  // @Flag takes a single { key, defaultValue } object — not positional args.
  return showNew ? this.newHome() : this.oldHome();
}
```

**`@RequireFeatureFlag`** — evaluated on demand over the Bridge API by `FeatureFlagService` (with a
5-minute in-memory cache). No live updates. Use it for simple route gating or occasional checks when you
don't want to run a flags client.

```typescript
import { RequireFeatureFlag } from '@nebulr-group/bridge-nestjs';

@Get('beta-feature')
@RequireFeatureFlag('beta-access')
getBetaFeature() { ... }

@Get('premium')
@RequireFeatureFlag({ all: ['premium-tier', 'active-subscription'] })
getPremiumFeature() { ... }

@Get('experimental')
@RequireFeatureFlag({ any: ['beta-tester', 'internal-user'] })
getExperimentalFeature() { ... }
```

#### Programmatic checks with `FeatureFlagService`

```typescript
import { FeatureFlagService } from '@nebulr-group/bridge-nestjs';

@Injectable()
export class ReportsService {
  constructor(private featureFlags: FeatureFlagService) {}

  async generateReport(accessToken: string) {
    const hasPdfExport = await this.featureFlags.isEnabled('pdf-export', accessToken);
    return hasPdfExport ? this.generatePdfReport() : this.generateBasicReport();
  }
}
```

### Public Routes

```typescript
import { Public } from '@nebulr-group/bridge-nestjs';

@Get('health')
@Public()
healthCheck() {
  return { status: 'ok' };
}
```

## Tenant data — `BridgeService`

Inject `BridgeService` and call `bridge.fromJwt(userJwt)` to read the current request's tenant —
subscription, entitlements, branding, and user — all from a single cached fetch (default 30s; concurrent
requests for the same user are deduped).

```typescript
import { Controller, Get, Headers, ForbiddenException } from '@nestjs/common';
import { BridgeService } from '@nebulr-group/bridge-nestjs';

@Controller('reports')
export class ReportsController {
  constructor(private readonly bridge: BridgeService) {}

  @Get('export')
  async export(@Headers('authorization') auth: string) {
    const tenant = this.bridge.fromJwt(auth.replace(/^Bearer\s+/i, ''));

    // Gate on a plan entitlement, server-side:
    if (!(await tenant.entitlements.can('pdf-export'))) {
      throw new ForbiddenException('Plan does not include PDF export');
    }

    const sub = await tenant.subscription;   // { plan: { slug, name }, status, endsAt?, gateEngaged? }
    return this.buildExport(sub.plan.slug);
  }
}
```

What you can read on the returned scope (each field lazily resolves the cached fetch):

| Member | Returns |
|---|---|
| `subscription` | `Promise<{ plan: { slug, name }, status, endsAt?, gateEngaged? }>` |
| `entitlements.can(key)` | `Promise<boolean>` |
| `entitlements.canSync(key, cached)` | `boolean` (after `snapshot()` is loaded) |
| `entitlements.snapshot()` | `Promise<Record<string, boolean>>` |
| `branding` | `Promise<{ logo, name, ...colors }>` |
| `user` | `Promise<{ id, email?, role, tenantId }>` |
| `snapshot()` | `Promise<SessionSnapshotData>` (the full payload) |
| `invalidate()` | force-refresh the cached snapshot on next access |

> **Billing on the backend** means *reading* subscription state and *enforcing* entitlements — there is no
> checkout or paywall here. Purchase and upgrade flows live in the frontend plugin and bridge-api webhooks.
> `bridge.tenant(tenantId)` (arbitrary-tenant access for cron/admin paths) is not yet wired and throws a
> clear error; use `bridge.fromJwt(userJwt)` from a request handler.

## Decorators

| Decorator | Description |
|-----------|-------------|
| `@CurrentUser()` | Inject the authenticated `BridgeUser` |
| `@CurrentTenant()` | Inject the `BridgeTenant` |
| `@Public()` | Mark a route public (skip auth) |
| `@RequireRole(role)` | Require a role (checked against the user JWT) |
| `@RequirePrivilege(privilege)` | Require an API-token privilege (user JWTs bypass) |
| `@AcceptAuth(type)` | Restrict accepted auth type: `'jwt' \| 'api_token' \| 'both'` |
| `@RequireFeatureFlag(req)` | Flag gating (single / `{ any }` / `{ all }`) over the Bridge API via `FeatureFlagService` |
| `@RequireFlag(key, default?, opts?)` | Flag gating via `BridgeFlagGuard`, with live updates (from `/flags`) |
| `@Flag({ key, defaultValue })` | Param decorator — inject a flag value (from `/flags`) |

## Configuration Options

```typescript
interface BridgeConfig {
  // Required
  appId: string;

  // Optional (with defaults)
  apiBaseUrl?: string;          // default: 'https://api.thebridge.dev'
  debug?: boolean;              // default: false

  // JWKS overrides — useful in Docker when the container can't reach the public apiBaseUrl
  apiTokenJwksUrl?: string;     // default: {apiBaseUrl}/auth/account/app/.well-known/jwks.json
  userJwksUrl?: string;         // default: {apiBaseUrl}/auth/.well-known/jwks.json

  // Guard configuration
  guard?: {
    global?: boolean;                        // Enable global guard
    defaultAccess?: 'public' | 'protected';  // Default: 'protected'
    rules?: RouteRule[];                     // Centralized route rules
  };
}

interface RouteRule {
  path?: string;             // REST URL wildcard pattern, e.g. "/account/subscription/**"
  graphqlOperation?: string; // GraphQL operation name, camelCase, e.g. "listUsers"
  privilege: RoutePrivilege; // Required privilege for matching requests
  plans?: string[];          // Optional: tenant plan must be one of these
}

// 'ANONYMOUS' | 'AUTHENTICATED' | 'USER_READ' | 'USER_WRITE' | 'TENANT_READ' | 'TENANT_WRITE' | string
type RoutePrivilege = string;
```

## Types

### BridgeUser

```typescript
interface BridgeUser {
  id: string;                   // sub claim
  email: string;
  emailVerified: boolean;
  username: string;             // preferred_username claim
  fullName: string;
  givenName?: string;
  familyName?: string;
  locale?: string;
  onboarded?: boolean;
  tenantId: string;
  appId?: string;               // aid claim
  scope?: string;               // OAuth scopes granted to the token
  role?: string;
  multiTenantAccess?: boolean;
  privileges?: string[];        // e.g. ['AUTHENTICATED', 'USER_READ']
}
```

`BridgeUser`, `JwtClaims`, `transformJwtToBridgeUser`, `TokenVerificationError`, and `ApiTokenClaims` are
re-exported from `@nebulr-group/bridge-auth-core/backend`.

### BridgeTenant

```typescript
interface BridgeTenant {
  id: string;
  name: string;
  locale?: string;
  logo?: string;
  onboarded?: boolean;
}
```

## Token Forwarding with BridgeHttpService

`BridgeHttpService` is an injectable service for calling downstream NestJS services, forwarding the
authenticated user's token so the downstream service can authenticate the same user.

```typescript
import { Controller, Get, Req } from '@nestjs/common';
import { BridgeHttpService } from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';

@Controller('items')
export class ItemsController {
  constructor(private readonly bridgeHttpService: BridgeHttpService) {}

  @Get('from-service-b')
  async getFromServiceB(@Req() req: Request) {
    return this.bridgeHttpService.get('http://service-b/items', req.bridgeAccessToken);
  }
}
```

Available methods:
- `get<T>(url, token?, options?): Promise<T>`
- `post<T>(url, body, token?, options?): Promise<T>`
- `put<T>(url, body, token?, options?): Promise<T>`
- `patch<T>(url, body, token?, options?): Promise<T>`
- `delete<T>(url, token?, options?): Promise<T>`

If `token` is `undefined` (public routes), the call is made without an Authorization header.
On non-2xx responses, a `BridgeHttpError` is thrown with `status` and `url` properties.

## Error Responses

### RFC 6750 WWW-Authenticate Headers

The guard sets `WWW-Authenticate` headers on 401 responses so clients can distinguish error conditions:

| Condition | Error code | WWW-Authenticate header |
|---|---|---|
| No Authorization header | `missing_token` | `Bearer error="missing_token"` |
| Token expired | `expired_token` | `Bearer error="expired_token"` |
| Token invalid/tampered | `invalid_token` | `Bearer error="invalid_token"` |
| JWKS no matching key | `invalid_token` | `Bearer error="invalid_token"` |

```
WWW-Authenticate: Bearer error="expired_token", error_description="The access token has expired"
```

Recommended client handling:
- `missing_token` → redirect user to login
- `expired_token` → attempt token refresh, then retry; redirect to login on failure
- `invalid_token` → redirect user to login

### 401 Unauthorized

```json
{ "statusCode": 401, "error": "Unauthorized", "message": "No authorization token was provided" }
```

### 403 Forbidden (Role)

```json
{ "statusCode": 403, "error": "Forbidden", "message": "Role 'ADMIN' required" }
```

### 403 Forbidden (Feature Flag)

```json
{ "statusCode": 403, "error": "Forbidden", "message": "Feature flag 'beta-access' is not enabled" }
```

## Read modes — channel vs pull

`BridgeFlagsModule.forRoot({...})` accepts a `runtimeMode` option that picks how the SDK stays fresh:

- **`'channel'`** (default) — opens a WebSocket to the per-app realtime channel. Use for **long-running
  services** (NestJS HTTP servers, workers) where live flag/quota/entitlement updates matter.
- **`'pull'`** — never opens a WebSocket. Use for **ephemeral runtimes** (cron jobs, serverless functions,
  webhook handlers, CLI scripts). Reads go through a TTL-bounded REST cache (`BridgePullCache`, default 30s).

```ts
BridgeFlagsModule.forRoot({
  apiBaseUrl: 'https://api.thebridge.dev',
  apiKey: process.env.BRIDGE_API_KEY!,
  runtimeMode: 'pull',
  pullCache: { ttlMs: 60_000 }, // override default 30s
});
```

The pull cache is also injectable in channel mode for REST routes that aren't channel-mirrored:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { BRIDGE_PULL_CACHE, BridgePullCache } from '@nebulr-group/bridge-nestjs/flags';

@Injectable()
export class ReportsService {
  constructor(@Inject(BRIDGE_PULL_CACHE) private readonly cache: BridgePullCache) {}

  async tenantConfig(tenantId: string) {
    return this.cache.get(`tenant:${tenantId}`, () => this.fetchFromRest(tenantId));
  }
}
```

In `'pull'` mode, push events don't exist — for server-side reactions, use Bridge webhooks instead.

## Documentation

In-depth guides live in [`../learning`](../learning):

- [Quickstart](../learning/quickstart/quickstart.md)
- [Authentication & Access Control](../learning/auth/auth.md)
- [Configuration](../learning/configuration/configuration.md)
- [Feature Flags](../learning/feature-flags/feature-flags.md)
- [Tenant Data — `BridgeService`](../learning/bridge-service/bridge-service.md)
- [Multi-Tenancy](../learning/multi-tenancy/multi-tenancy.md)
- [Frontend Integration](../learning/frontend-integration/frontend-integration.md)
- [Error Handling](../learning/error-handling/error-handling.md)

## License

MIT
