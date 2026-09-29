---
title: Configuration
description: The BridgeConfig options behind BridgeModule.forRoot/forRootAsync, covering the guard, verification-URL overrides, and route rules.
sidebar:
  label: NestJS
---

# Configuration

Everything auth-related in `@nebulr-group/bridge-nestjs` is wired up through one call: `BridgeModule.forRoot()` (static) or `BridgeModule.forRootAsync()` (when a value has to come from `ConfigService` or another async source).

```typescript
import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';

@Module({
  imports: [
    BridgeModule.forRoot({
      appId: 'YOUR_APP_ID',
      guard: {
        global: true,
        defaultAccess: 'protected',
        rules: [{ path: '/health', privilege: 'ANONYMOUS' }],
      },
    }),
  ],
})
export class AppModule {}
```

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';

@Module({
  imports: [
    ConfigModule.forRoot(),
    BridgeModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        appId: config.get<string>('BRIDGE_APP_ID'),
        debug: config.get<string>('BRIDGE_DEBUG') === 'true',
        guard: { global: true, defaultAccess: 'protected' },
      }),
    }),
  ],
})
export class AppModule {}
```

Both register the same providers (`BridgeConfigService`, `JwksService`, `FeatureFlagService`, `BridgeAuthGuard`, `BridgeHttpService`, `BridgeService`); `forRootAsync` just resolves the config object (and, separately, whether the global guard is enabled) at runtime instead of at import time.

## `BridgeConfig`: all options

```typescript
interface BridgeConfig {
  /** Your Bridge app ID (required) */
  appId: string;

  /** Base URL for the Bridge API. All endpoints are derived from this.
   *  @default 'https://api.thebridge.dev' */
  apiBaseUrl?: string;

  /** Guard configuration (see below) */
  guard?: GuardConfig;

  /** Enable debug logging (default: false) */
  debug?: boolean;

  /** Override the token-introspection URL used to verify API tokens.
   *  @default {apiBaseUrl}/account/api-token/introspect */
  introspectionUrl?: string;

  /** How long (ms) a successful API-token introspection is cached, keyed
   *  by token. 0 disables caching, so every request introspects and
   *  revocation is instant.
   *  @default 0 */
  introspectionCacheTtlMs?: number;

  /** Override the JWKS URL used to verify user JWTs.
   *  @default {apiBaseUrl}/auth/.well-known/jwks.json */
  userJwksUrl?: string;
}
```

The two credential types verify differently, and the overrides mirror that split. User JWTs are verified **locally** against Bridge's JWKS keyset (`userJwksUrl`); API tokens are signed with a per-app secret your app never holds, so they're verified **remotely** by POSTing them to Bridge's introspection endpoint (`introspectionUrl`). Both URL overrides exist for one reason in practice: a container that can't reach the public `apiBaseUrl` from inside its own network (a Docker Compose setup resolving Bridge's API by an internal hostname, for instance). Leave them unset and they're derived automatically. See [API tokens](/auth/api-tokens/) and [Logging in and logging out](/auth/user-token/logging-in-and-out/) for how each verification path behaves.

`introspectionCacheTtlMs` trades revocation latency for fewer network calls: with the default `0`, every API-token request introspects (a revoked token fails on its very next call); with a positive TTL, a just-revoked token can keep passing for up to that long.

## `GuardConfig`: turning the guard on

```typescript
interface GuardConfig {
  /** Register BridgeAuthGuard as a global guard, applied to every route (default: false) */
  global?: boolean;

  /** Access level when no route rule matches (default: 'protected') */
  defaultAccess?: 'public' | 'protected';

  /** Centralized route rules (see below) */
  rules?: RouteRule[];
}
```

Without `global: true`, nothing is protected automatically; you'd apply `BridgeAuthGuard` with `@UseGuards()` per-controller or per-route instead. Most apps set `global: true` and then punch holes for public routes with `@Public()` or an `ANONYMOUS` rule, rather than the other way around. See [Route guards](/auth/securing/route-guards/) for the full precedence order (`@Public()` → `ANONYMOUS` rule → `defaultAccess` → credential check → the rest).

## `RouteRule`: centralized rules instead of decorating every controller

```typescript
interface RouteRule {
  /** REST URL wildcard pattern, e.g. '/account/subscription/**' */
  path?: string;
  /** GraphQL operation name, case-sensitive camelCase, e.g. 'listUsers' */
  graphqlOperation?: string;
  /** Whether the route needs a signed-in caller: 'ANONYMOUS' or 'AUTHENTICATED' */
  privilege: RoutePrivilege;
  /** The flag that decides who gets this route; its rule says why */
  featureFlag?: string | { any: string[] } | { all: string[] };
}
```

Provide `path` for REST, `graphqlOperation` for GraphQL, or both if the same rule needs to cover both surfaces conceptually (they're matched independently: a REST request only ever matches on `path`, a GraphQL request only ever matches on `graphqlOperation`). Rules are evaluated in array order; the first match wins.

```typescript
BridgeModule.forRoot({
  appId: 'YOUR_APP_ID',
  guard: {
    global: true,
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/webhooks/*', privilege: 'ANONYMOUS' },
      { path: '/api/status', privilege: 'AUTHENTICATED' },
      { path: '/users/*', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
      { path: '/account/subscription/*', privilege: 'AUTHENTICATED', featureFlag: 'manage-billing' },
      { graphqlOperation: 'listUsers', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
      { graphqlOperation: 'deleteUser', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
    ],
  },
})
```

**Who gets a route is a flag.** `privilege` only says whether the route needs a signed-in caller; `featureFlag` (or `@RequireFeatureFlag()` on the handler) decides who gets it, and the flag's rule says why, e.g. `privileges contains "USER_WRITE"` for `manage-users`. See [Gate with feature flags](/auth/roles/gate-with-flags/).

## `RoutePrivilege`: what a rule's `privilege` can be

```typescript
type RoutePrivilege =
  | 'ANONYMOUS'       // no authentication required; same effect as @Public()
  | 'AUTHENTICATED';  // any valid credential, user JWT or API token
```

Nothing else. A rule that still carries a privilege key such as `USER_READ`, or the removed `plans` / `entitlement` / `role` options, stops the app at startup with an error naming the flag setup to use instead: `featureFlag` with the flag ruled on that privilege (or on `bridge:billing.entitlement.<key>` for a plan feature). An API token's scope is `@RequirePrivilege()` on the handler, API tokens only (see [API tokens](/auth/api-tokens/)).

## Environment variables

Nothing here is read from the environment automatically; `BridgeConfig` is always an object you build and pass in. The common pattern is reading from `process.env` yourself (directly in `forRoot`, or via `ConfigService` in `forRootAsync`):

```env
BRIDGE_APP_ID=your-app-id-here
BRIDGE_DEBUG=true
```

```typescript
BridgeModule.forRoot({
  appId: process.env.BRIDGE_APP_ID!,
  debug: process.env.BRIDGE_DEBUG === 'true',
})
```

## `BridgeModuleAsyncOptions`

```typescript
interface BridgeModuleAsyncOptions {
  imports?: any[];
  inject?: any[];
  useFactory: (...args: any[]) => Promise<BridgeConfig> | BridgeConfig;
}
```

Standard Nest async-provider shape: `useFactory` can return a `Promise<BridgeConfig>` if resolving it needs an `await` (fetching a secret at startup, for instance).
