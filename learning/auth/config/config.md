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
  /** Required privilege level for this route */
  privilege: RoutePrivilege;
  /** Present on the type for a future plan-restriction feature.
   *  Not currently enforced by BridgeAuthGuard. */
  plans?: string[];
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
      { path: '/users/*', privilege: 'USER_READ' },
      { path: '/account/subscription/*', privilege: 'TENANT_WRITE' },
      { graphqlOperation: 'listUsers', privilege: 'USER_READ' },
      { graphqlOperation: 'deleteUser', privilege: 'USER_WRITE' },
    ],
  },
})
```

**Roles and feature flags are decorator-only** (`@RequireRole()`, `@RequireFeatureFlag()`/`@RequireFlag()`); they don't have a place in `RouteRule`. Route rules cover the `privilege` axis (public/anonymous access and privilege-gating); see [How roles & privileges work](/auth/roles/how-it-works/) for why that split exists and which credential type each check applies to.

## `RoutePrivilege`: what a rule's `privilege` can be

```typescript
type RoutePrivilege =
  | 'ANONYMOUS'       // no authentication required; same effect as @Public()
  | 'AUTHENTICATED'   // any valid credential, user JWT or API token
  | 'USER_READ'
  | 'USER_WRITE'
  | 'TENANT_READ'
  | 'TENANT_WRITE'
  | string;           // any custom privilege key you've defined
```

The four named privileges beyond `ANONYMOUS`/`AUTHENTICATED` are just conventions, not a closed set; anything you've created as a privilege key (see [Define roles & privileges](/auth/roles/define-roles/)) works here too. A rule's `privilege` (anything past `ANONYMOUS`/`AUTHENTICATED`) is enforced against the **user JWT's** `privileges` claim only. It has no effect on an API-token-only request, the same split that applies to `@RequireRole()`.

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
