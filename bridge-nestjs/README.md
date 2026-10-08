<p align="center">
  <a href="https://thebridge.dev/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs"><picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thebridgedev/bridge-nestjs/main/.github/assets/banner.png"><img src="https://raw.githubusercontent.com/thebridgedev/bridge-nestjs/main/.github/assets/banner-light.png" alt="The Bridge for NestJS" width="100%"></picture></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nebulr-group/bridge-nestjs"><img src="https://img.shields.io/npm/v/@nebulr-group/bridge-nestjs?color=20006b&label=npm" alt="npm version"></a>
  <a href="https://github.com/thebridgedev/bridge-nestjs/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@nebulr-group/bridge-nestjs?color=20006b" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://thebridge.dev/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs"><b>Website</b></a> ·
  <a href="https://thebridge.dev/docs/quickstart/nestjs/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs"><b>Quickstart</b></a> ·
  <a href="https://thebridge.dev/docs/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs"><b>Docs</b></a> ·
  <a href="https://thebridge.dev/docs/ai-assistants/mcp/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs"><b>Set up with your AI assistant</b></a>
</p>

# The Bridge for NestJS

`@nebulr-group/bridge-nestjs` protects a NestJS API with Bridge: token verification, flag-gated endpoints, plan limits and tenant data, as a module, a guard and decorators.

**[The Bridge](https://thebridge.dev/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs)** is a hosted backend for SaaS apps. It gives you sign-in (passwords, magic links, passkeys, social login and SSO), multi-tenant workspaces with roles, Stripe subscriptions with plan limits, and feature flags, all managed from one dashboard. Your AI coding assistant can set it up for you through the [Bridge MCP server](https://thebridge.dev/docs/ai-assistants/mcp/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs).

> **Let your AI assistant set it up.** Connect the [Bridge MCP server](https://thebridge.dev/docs/ai-assistants/mcp/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs) to Claude, Cursor, Copilot or Gemini CLI and ask it to add Bridge to your app. Not using MCP? Run `npx @nebulr-group/bridge-cli guide add-login` in your project: it detects your framework from `package.json` and prints the steps for your assistant to follow. `npx @nebulr-group/bridge-cli doctor` checks the result.

Built on [`@nebulr-group/bridge-auth-core`](https://www.npmjs.com/package/@nebulr-group/bridge-auth-core) — all JWT and API-token verification is delegated to auth-core's framework-agnostic `JwksService`. This plugin adds the NestJS dependency-injection layer: a module, a guard, decorators, and the request-scoped `BridgeService`.

## The one rule for app code

**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains "USER_WRITE"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.

Two things are not gates and are not flags: **numbers** are plan limits (`<QuotaGate>` in the browser, `@RequireQuota` on the backend), and **permission on one specific record** stays in app code ("only the author edits their post").

Before calling the work done, run `npx @nebulr-group/bridge-cli check gates` in the project. It lists every direct role, privilege, plan or plan-feature check with the flag to use instead. Fix each one.

In NestJS, an endpoint is `@RequireFeatureFlag('…')` on the handler (or a route rule with `featureFlag`).

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
    // Reads BRIDGE_APP_ID, BRIDGE_API_BASE_URL and BRIDGE_DEBUG from the environment.
    // Anything passed here wins: BridgeModule.forRoot({ appId: 'your-app-id' }).
    BridgeModule.forRoot(),
  ],
})
export class AppModule {}
```

### Global Guard with Route Rules

A rule's `privilege` says whether the route needs a signed-in caller: `'ANONYMOUS'` or
`'AUTHENTICATED'`. Who gets the route is a flag — the rule's `featureFlag`, or `@RequireFeatureFlag` /
`@RequireFlag` on the controller or route — and the flag's rule says why (a privilege, a plan feature, a
rollout). A rule that still passes a privilege key, `plans` or `entitlement` stops the app at startup with
an error naming the flag setup to use instead.

```typescript
BridgeModule.forRoot({
  appId: 'your-app-id',
  guard: {
    global: true,
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/account/users', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
      { path: '/reports/*', privilege: 'AUTHENTICATED', featureFlag: 'reports' },
      { graphqlOperation: 'listUsers', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
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

### Who gets an endpoint — a flag

An admin area is a flag ruled on a privilege, e.g. `privileges contains "USER_WRITE"` (in the default
setup ADMIN and OWNER hold it; read the app's real roles and privileges with `list_roles` /
`bridge role list` before writing the rule). The code asks the flag and never reads the role.

```typescript
import { RequireFeatureFlag } from '@nebulr-group/bridge-nestjs';

@Controller('admin')
@UseGuards(BridgeAuthGuard)
@RequireFeatureFlag('admin-area')
export class AdminController {
  @Get('settings')
  @RequireFeatureFlag('admin-settings') // its own flag, e.g. privileges contains "TENANT_WRITE"
  getSettings() { ... }
}
```

### API-token scopes — `@RequirePrivilege` (API tokens only)

`@RequirePrivilege` is the scope an API token (`x-api-key`) must carry — for machine callers such as
scripts and integrations. It is not a gate on a person: a signed-in user (`Authorization: Bearer`) is not
checked against it. Gate people with a flag.

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
[Feature Flags guide](https://thebridge.dev/docs/feature-flags/nestjs/) for setup (`BridgeFlagsModule`,
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

A flag rule on a privilege or a plan feature works here the same as in the browser, with no wiring: on a
request `BridgeAuthGuard` verified, the guard and `@Flag` fill in `privileges` and the other token
attributes, plus the workspace's `bridge:billing.entitlement.<feature>` (read from Bridge, cached per
workspace) when `BridgeModule` is loaded. Client-sent values are never used. Prefer a privilege rule over a
role rule, and for a feature a plan sells, list it on the plans (`bridge plan feature add <plan> <feature>`)
and rule the flag `bridge:billing.entitlement.<feature> eq true`. See
[Target by plan feature or privilege](https://thebridge.dev/docs/feature-flags/targeting/).

**`@RequireFeatureFlag`** — evaluated on demand over the Bridge API by `FeatureFlagService` (with a
5-minute in-memory cache). No live updates. Use it for simple route gating or occasional checks when you
don't want to run a flags client. Bridge resolves `privileges` and the workspace's
`bridge:billing.entitlement.<feature>` for it, so privilege and plan-feature rules work here too
(plan-limit numbers, `bridge:billing.quota.*`, need `@RequireFlag`).

Both flag paths say why they refused: `402 FEATURE_NOT_IN_PLAN` when an upgrade alone would turn the
feature on (with `fix` = where to upgrade), `403 FEATURE_NOT_PERMITTED` for a role or privilege reason,
and `403 FEATURE_OFF` otherwise. Each body names the `flag`.

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

Inject `BridgeService` and call `bridge.fromRequest(req)` on a route behind `BridgeAuthGuard` to read the
current request's tenant — subscription, entitlements, branding, and user — all from a single cached fetch
(default 30s; concurrent requests for the same user are deduped). `fromRequest` reuses the token the guard
already verified. Where you hold a token some other way, `bridge.fromJwt(token)` verifies it exactly as the
guard does (signature, issuer, audience, expiry) before reading anything; a token that fails rejects every
read with `TokenVerificationError` and never touches another user's cached data. Never build a scope from
the raw `Authorization` header on an unguarded route by decoding it yourself. A newer token for the same user refreshes it at once: Bridge
re-issues a user's token when their plan or entitlements change, and the frontend SDKs pick that token up
within a second, so flag rules on plan features follow an upgrade on the user's next request. A client
that keeps presenting its old token sees the change within the 30s.

```typescript
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { BridgeAuthGuard, BridgeService, RequireFeatureFlag } from '@nebulr-group/bridge-nestjs';

@Controller('reports')
@UseGuards(BridgeAuthGuard)
export class ReportsController {
  constructor(private readonly bridge: BridgeService) {}

  @Get('export')
  @RequireFeatureFlag('pdf-export') // flag rule: bridge:billing.entitlement.pdf_export eq true
  async export(@Req() req: Request) {
    const tenant = this.bridge.fromRequest(req);
    const sub = await tenant.subscription;   // { plan: { slug, name }, status, endsAt?, gateEngaged? }
    return this.buildExport(sub.plan.slug);
  }
}
```

What you can read on the returned scope (each field lazily resolves the cached fetch):

| Member | Returns |
|---|---|
| `subscription` | `Promise<{ plan: { slug, name }, status, endsAt?, gateEngaged? }>` |
| `entitlements` | the plan's features — a direct read, see [Exceptions](#exceptions--direct-plan-feature-checks) |
| `branding` | `Promise<{ logo, name, ...colors }>` |
| `user` | `Promise<{ id, email?, role, tenantId }>` |
| `usage.report(metric, value?, key?)` | `Promise<void>` — report a counter event (TBP-275) |
| `usage.set(metric, count)` | `Promise<void>` — set a gauge to how many exist right now (TBP-699) |
| `usage.quota(metric)` | `Promise<QuotaSnapshot \| null>` — live quota incl. metered overage cost |
| `snapshot()` | `Promise<SessionSnapshotData>` (the full payload) |
| `invalidate()` | `Promise<void>` — force-refresh the cached snapshot on next access |

> **Billing on the backend** means *reading* subscription state and *enforcing* plan limits — there is no
> checkout or paywall here. Purchase and upgrade flows live in the frontend plugin and bridge-api webhooks.
> `bridge.tenant(tenantId)` (arbitrary-tenant access for cron/admin paths) is not yet wired and throws a
> clear error; use `bridge.fromRequest(req)` from a request handler.

## Plan limits — `@RequireQuota`, `@SyncQuota`

One decorator on the handler that creates the thing refuses the request at the plan limit and records
usage after a 2xx — a POST increments the limit, with nothing else to wire. Direct API calls hit the same gate.
If deleting it frees room, it's a gauge and your app counts it (`current`); if it happened, it's a counter
and Bridge counts it. [Plan limits](https://github.com/thebridgedev/bridge-nestjs/blob/main/learning/plan-limits/plan-limits.md)
has the whole model; coding agents get it from `npx @nebulr-group/bridge-cli guide mechanisms`.

```typescript
@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Post()   // gauge: things that exist — your app counts them
  @RequireQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  create() {}

  @Delete(':id')   // no check; sets Bridge's copy of the count after a 2xx
  @SyncQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  remove() {}

  @Post(':id/export')   // counter: things that happened — Bridge counts, keyed by Idempotency-Key
  @RequireQuota('exports')
  export() {}
}
```

- Refusal: `402 { code: 'QUOTA_EXCEEDED', metric, used, limit, fix }`.
  `fix` is `billing.manageRoute` (default `/subscription`).
- `metered` quotas never refuse. Nothing is recorded for a 4xx/5xx or a thrown handler; exactly one write per metric otherwise.
- Needs a user verified by `BridgeAuthGuard`; no verified user → 401. Quota unreadable → 503 (fail closed).
- The same calls without decorators: `BridgeQuotaService` — `check`, `assertQuota`, `record`, `sync`.
- Who may use the feature at all is a flag (`@RequireFeatureFlag`); the quota is only the number.

## Exceptions — direct plan-feature checks

For the rare case where the developer explicitly asks for no flag, the plan can be read directly:
`@RequireEntitlement('analytics')` on a handler or controller (403
`{ code: 'ENTITLEMENT_REQUIRED', entitlement, fix }`), `BridgeQuotaService.assertEntitlement(req, key)`,
or `bridge.fromRequest(req).entitlements.can(key)` / `canSync(key, cached)` / `snapshot()`. Outside
production, `@RequireEntitlement` logs a one-time note naming the flag rule to use instead.

## Decorators

| Decorator | Description |
|-----------|-------------|
| `@CurrentUser()` | Inject the authenticated `BridgeUser` |
| `@CurrentTenant()` | Inject the `BridgeTenant` |
| `@Public()` | Mark a route public (skip auth) |
| `@RequirePrivilege(privilege)` | API tokens only: the scope an `x-api-key` caller must carry |
| `@AcceptAuth(type)` | Restrict accepted auth type: `'jwt' \| 'api_token' \| 'both'` |
| `@RequireQuota(metric, { current? })` | Plan limit: 402 at the limit, records usage after a 2xx |
| `@SyncQuota(metric, { current })` | Sets a gauge to your count after a 2xx (deletes, bulk) |
| `@RequireFeatureFlag(req)` | Flag gating (single / `{ any }` / `{ all }`) over the Bridge API via `FeatureFlagService` |
| `@RequireFlag(key, default?, opts?)` | Flag gating via `BridgeFlagGuard`, with live updates (from `/flags`) |
| `@Flag({ key, defaultValue })` | Param decorator — inject a flag value (from `/flags`) |

## Configuration Options

```typescript
interface BridgeConfig {
  // Required — forRoot() falls back to BRIDGE_APP_ID
  appId: string;

  // Optional (with defaults)
  apiBaseUrl?: string;          // default: BRIDGE_API_BASE_URL, else 'https://api.thebridge.dev'
  debug?: boolean;              // default: BRIDGE_DEBUG === 'true'
  billing?: { manageRoute?: string }; // `fix` in quota/entitlement refusals; default '/subscription'

  // Verification-endpoint overrides — useful in Docker when the container
  // can't reach the public apiBaseUrl
  introspectionUrl?: string;       // default: {apiBaseUrl}/account/api-token/introspect
  introspectionCacheTtlMs?: number; // default: 0 (introspect every request)
  userJwksUrl?: string;            // default: {apiBaseUrl}/auth/.well-known/jwks.json

  // Deprecated (TBP-411): API tokens are HS256-signed with a per-app secret and
  // can never be verified against a JWKS. Ignored — use introspectionUrl.
  apiTokenJwksUrl?: string;

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
  privilege: RoutePrivilege; // Does the route need a signed-in caller?
  featureFlag?: FeatureFlagRequirement; // Who gets it — the flag's rule says why
}

type RoutePrivilege = 'ANONYMOUS' | 'AUTHENTICATED';
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

### 403 Forbidden (Feature Flag)

```json
{ "statusCode": 403, "error": "Forbidden", "message": "Feature flag 'beta-access' is not enabled" }
```

## Read modes — channel vs pull

`BridgeFlagsModule.forRoot({...})` loads your app's flag rules before the module finishes initialising
(waiting at most 5s), so the first request already sees real values. The app is taken from the `appId`
claim of a Bridge API token; pass `appId` explicitly if your `apiKey` isn't one. `runtimeMode` picks how
the rules stay fresh after that:

- **`'channel'`** (default) — subscribes to the app's live channel with the API key as its credential, where
  the Bridge deployment admits server SDKs to it (it says so on `GET /realtime/config`). Changes then apply
  as they happen, and the rules reload whenever the connection (re)opens. While no channel is open, the
  rules refresh every `pullCache.ttlMs` (default 30s). Use for **long-running services**.
- **`'pull'`** — never opens a WebSocket. Use for **ephemeral runtimes** (cron jobs, serverless functions,
  webhook handlers, CLI scripts). The rules refresh at most every `pullCache.ttlMs` (default 30s), triggered
  by reads, so an idle function does no work.

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

## Learn more

- [Quickstart](https://thebridge.dev/docs/quickstart/nestjs/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs)
- [Authentication](https://thebridge.dev/docs/auth/nestjs/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs)
- [Feature flags](https://thebridge.dev/docs/feature-flags/nestjs/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs)
- [Plan limits](https://thebridge.dev/docs/plan-limits/nestjs/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs)
- [Tenant data](https://thebridge.dev/docs/bridge-service/nestjs/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs)
- [Multi-tenancy](https://thebridge.dev/docs/multi-tenancy/nestjs/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs)
- [Error handling](https://thebridge.dev/docs/error-handling/nestjs/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs)
- [Examples](https://thebridge.dev/docs/examples/nestjs/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs)

## Other Bridge packages

| Package | For |
|---|---|
| [`@nebulr-group/bridge-svelte`](https://www.npmjs.com/package/@nebulr-group/bridge-svelte) | SvelteKit |
| [`@nebulr-group/bridge-react`](https://www.npmjs.com/package/@nebulr-group/bridge-react) | React |
| [`@nebulr-group/bridge-nextjs`](https://www.npmjs.com/package/@nebulr-group/bridge-nextjs) | Next.js |
| [`@nebulr-group/bridge-angular`](https://www.npmjs.com/package/@nebulr-group/bridge-angular) | Angular |
| [`@nebulr-group/bridge-express`](https://www.npmjs.com/package/@nebulr-group/bridge-express) | Express |
| [`@nebulr-group/bridge-cli`](https://www.npmjs.com/package/@nebulr-group/bridge-cli) | CLI for people and AI agents |
| [`@nebulr-group/bridge-auth-core`](https://www.npmjs.com/package/@nebulr-group/bridge-auth-core) | Any JavaScript app (core) |

## License

[MIT](https://github.com/thebridgedev/bridge-nestjs/blob/main/LICENSE) © Nebulr. Built by [The Bridge](https://thebridge.dev/?utm_source=npm&utm_medium=readme&utm_campaign=bridge-nestjs).
