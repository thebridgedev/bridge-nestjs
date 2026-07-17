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

Route rules use the `privilege` field to control access. Roles and feature flags are applied via decorators, **not** in route rules.

```typescript
interface RouteRule {
  /** REST URL wildcard pattern (e.g. "/account/subscription/**") */
  path?: string;

  /** GraphQL operation name, case-sensitive camelCase (e.g. "listUsers") */
  graphqlOperation?: string;

  /** Required privilege level for this route */
  privilege: RoutePrivilege;

  /** Present on the type for a future plan-restriction feature.
   *  Not currently enforced by BridgeAuthGuard. */
  plans?: string[];
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

      // Require specific privilege in JWT
      { path: '/users/*', privilege: 'USER_READ' },
      { path: '/account/subscription/*', privilege: 'TENANT_WRITE' },

      // GraphQL operation rules
      { graphqlOperation: 'listUsers', privilege: 'USER_READ' },
      { graphqlOperation: 'deleteUser', privilege: 'USER_WRITE' },
    ],
  },
})
```

> The `plans` field on `RouteRule` is not enforced by `BridgeAuthGuard` yet. To gate a route by subscription plan today, check entitlements or the plan programmatically with `BridgeService`; see [Tenant Data (`BridgeService`)](../bridge-service/bridge-service.md).

### RoutePrivilege type reference

```typescript
type RoutePrivilege =
  | 'ANONYMOUS'       // No authentication required
  | 'AUTHENTICATED'   // Any valid JWT (user or API token)
  | 'USER_READ'       // Requires USER_READ in JWT privileges claim
  | 'USER_WRITE'      // Requires USER_WRITE in JWT privileges claim
  | 'TENANT_READ'     // Requires TENANT_READ in JWT privileges claim
  | 'TENANT_WRITE'    // Requires TENANT_WRITE in JWT privileges claim
  | string;           // Any custom privilege string
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
