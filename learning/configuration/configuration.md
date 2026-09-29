# Configuration Reference

### BridgeConfig type

```typescript
interface BridgeConfig {
  /** Your Bridge app ID (required) */
  appId: string;

  /** Base URL for the Bridge API. All endpoints are derived from this.
   *  @default 'https://api.thebridge.dev' */
  apiBaseUrl?: string;

  /** Guard configuration */
  guard?: GuardConfig;

  /** Enable debug logging (default: false) */
  debug?: boolean;

  /** Override the token-introspection URL for API token verification.
   *  API tokens are signed with a per-app secret your app never holds, so
   *  they're verified by POSTing them to the Bridge rather than locally.
   *  @default {apiBaseUrl}/account/api-token/introspect */
  introspectionUrl?: string;

  /** How long (ms) a successful API-token introspection is cached, keyed
   *  by token. 0 disables caching: every request introspects, so
   *  revocation is instant.
   *  @default 0 */
  introspectionCacheTtlMs?: number;

  /** Override the JWKS URL for user JWT verification.
   *  @default {apiBaseUrl}/auth/.well-known/jwks.json */
  userJwksUrl?: string;
}
```

`introspectionUrl` and `userJwksUrl` exist mainly for containers that can't reach the public `apiBaseUrl` from inside their own network (a Docker Compose setup resolving Bridge's API by an internal hostname, for instance). Leave them unset and they're derived automatically.

### BridgeModule.forRoot()

Static configuration:

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
        rules: [
          { path: '/health', privilege: 'ANONYMOUS' },
        ],
      },
    }),
  ],
})
export class AppModule {}
```

### BridgeModule.forRootAsync()

Async configuration with factory:

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
        apiBaseUrl: config.get<string>('BRIDGE_API_BASE_URL') || undefined,
        debug: config.get<string>('BRIDGE_DEBUG') === 'true',
        guard: {
          global: true,
          defaultAccess: 'protected',
          rules: [
            { path: '/health', privilege: 'ANONYMOUS' },
          ],
        },
      }),
    }),
  ],
})
export class AppModule {}
```

The `BridgeModuleAsyncOptions` type:

```typescript
interface BridgeModuleAsyncOptions {
  imports?: any[];
  inject?: any[];
  useFactory: (...args: any[]) => Promise<BridgeConfig> | BridgeConfig;
}
```

### Environment variables

Nothing is read from the environment automatically; `BridgeConfig` is always an object you build and pass in. The common pattern is reading from `process.env` yourself (directly in `forRoot`, or via `ConfigService` in `forRootAsync`):

| Variable | Description | Default |
|----------|-------------|---------|
| `BRIDGE_APP_ID` | Your Bridge app ID | (required) |
| `BRIDGE_API_BASE_URL` | Bridge API base URL | `https://api.thebridge.dev` |
| `BRIDGE_DEBUG` | Enable debug logging | `false` |

Example `.env` file:

```env
BRIDGE_APP_ID=your-app-id-here
BRIDGE_DEBUG=true
```

### Route rules reference

A route rule's `privilege` says whether the route needs a signed-in caller (`'ANONYMOUS'` or `'AUTHENTICATED'`). Who gets the route is a flag: the rule's `featureFlag`, or `@RequireFeatureFlag` on the handler. The flag's rule says why (a privilege such as `privileges contains "USER_WRITE"`, a plan feature, a rollout).

```typescript
interface RouteRule {
  /** REST URL wildcard pattern (e.g. "/account/subscription/**") */
  path?: string;

  /** GraphQL operation name, case-sensitive camelCase (e.g. "listUsers") */
  graphqlOperation?: string;

  /** Does the route need a signed-in caller? */
  privilege: RoutePrivilege;

  /** Who gets the route — a flag whose rule says why.
   *  Off → 402 FEATURE_NOT_IN_PLAN / 403 FEATURE_NOT_PERMITTED / 403 FEATURE_OFF. */
  featureFlag?: FeatureFlagRequirement;
}
```

Provide either `path` (REST), `graphqlOperation` (GraphQL), or both.

**Examples:**

```typescript
BridgeModule.forRoot({
  appId: 'YOUR_APP_ID',
  guard: {
    global: true,
    defaultAccess: 'protected',
    rules: [
      // Public endpoints (no auth required)
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/webhooks/*', privilege: 'ANONYMOUS' },

      // Any valid token (user JWT or API token)
      { path: '/api/status', privilege: 'AUTHENTICATED' },

      // Who gets it is a flag (e.g. `manage-users` ruled `privileges contains "USER_WRITE"`)
      { path: '/users/*', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
      { path: '/account/subscription/*', privilege: 'AUTHENTICATED', featureFlag: 'manage-billing' },

      // GraphQL operation rules
      { graphqlOperation: 'listUsers', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
      { graphqlOperation: 'deleteUser', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
    ],
  },
})
```

> For a feature a plan sells, list it on the plans (`bridge plan feature add <plan> <feature>`) and rule the flag `bridge:billing.entitlement.<feature> eq true`. A rule that passes anything other than `'ANONYMOUS'` / `'AUTHENTICATED'` as `privilege`, or a `plans` / `entitlement` key, stops the app at startup with an error naming the flag setup to use instead.

### RoutePrivilege type reference

```typescript
type RoutePrivilege =
  | 'ANONYMOUS'       // No authentication required
  | 'AUTHENTICATED';  // Any valid credential (user JWT or API token)
```

### GuardConfig type reference

```typescript
interface GuardConfig {
  /** Enable global guard, applied to all routes (default: false) */
  global?: boolean;

  /** Default access level when no rule matches (default: 'protected') */
  defaultAccess?: 'public' | 'protected';

  /** Route rules for centralized configuration */
  rules?: RouteRule[];
}
```
