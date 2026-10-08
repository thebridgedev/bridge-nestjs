# Bridge NestJS Quickstart Guide

Get started with The Bridge NestJS plugin for backend authentication, privilege-based access control, API token support, and feature flags.

> **Let your AI assistant set it up.** Connect the [Bridge MCP server](https://thebridge.dev/docs/ai-assistants/mcp/) to Claude, Cursor, Copilot or Gemini CLI and ask it to add Bridge to your app. Not using MCP? Run `npx @nebulr-group/bridge-cli guide add-login` in your project: it detects your framework from `package.json` and prints the steps for your assistant to follow. `npx @nebulr-group/bridge-cli doctor` checks the result.

## Install the plugin

```bash
npm install @nebulr-group/bridge-nestjs
```

## Basic setup

Two lines in your root module and one environment variable are the whole integration:

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';

@Module({
  imports: [BridgeModule.forRoot({ guard: { global: true } })],
})
export class AppModule {}
```

```env
# .env
BRIDGE_APP_ID=your-app-id
# Only for a stage, local or self-hosted app:
# BRIDGE_API_BASE_URL=https://api-stage.thebridge.dev
```

`forRoot()` reads `BRIDGE_APP_ID`, `BRIDGE_API_BASE_URL` and `BRIDGE_DEBUG`; an option you pass wins over the environment. With no app id it refuses to start and names the variable. NestJS does not load `.env` itself, so start the app with the variables in its environment, e.g. `node --env-file=.env dist/main.js`. `guard.global: true` protects every route; the next section adds exceptions.

A plan limit is one more decorator on the handler that creates the thing — see [Plan limits](../plan-limits/plan-limits.md).

## Global guard with route rules

For most applications, enable the global guard with route rules. This protects all routes by default and lets you define exceptions using the `privilege` field:

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';

@Module({
  imports: [
    BridgeModule.forRoot({
      debug: true, // Enable for development (or BRIDGE_DEBUG=true)
      guard: {
        global: true,
        defaultAccess: 'protected',
        rules: [
          // Public routes (no auth required)
          { path: '/health', privilege: 'ANONYMOUS' },
          { path: '/webhooks/*', privilege: 'ANONYMOUS' },

          // Who gets a route is a flag; its rule says why
          // (e.g. `manage-users` ruled `privileges contains "USER_WRITE"`)
          { path: '/users/*', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
        ],
      },
    }),
  ],
})
export class AppModule {}
```

All routes are now protected by default, with the exceptions you defined.

> **Note:** Every gate is a flag: a route rule's `featureFlag`, or `@RequireFeatureFlag()` / `@RequireFlag()` (from `@nebulr-group/bridge-nestjs/flags`) on a controller or handler. The flag's rule says why — a privilege, a plan feature, a rollout. See the [feature flags documentation](../feature-flags/feature-flags.md).

## Accessing the authenticated user

Use the `@CurrentUser()` decorator to access the authenticated user in your controllers:

```typescript
// src/items/items.controller.ts
import { Controller, Get } from '@nestjs/common';
import { CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('items')
export class ItemsController {
  @Get()
  findAll(@CurrentUser() user: BridgeUser) {
    console.log('User:', user.email);
    console.log('Tenant:', user.tenantId);
    console.log('Privileges:', user.privileges);
    return this.itemsService.findByTenant(user.tenantId);
  }
}
```

## Accessing tenant information

Use the `@CurrentTenant()` decorator to access tenant details:

```typescript
import { CurrentUser, CurrentTenant, BridgeUser, BridgeTenant } from '@nebulr-group/bridge-nestjs';

@Get()
findAll(
  @CurrentUser() user: BridgeUser,
  @CurrentTenant() tenant: BridgeTenant,
) {
  console.log('Tenant name:', tenant.name);
  return { userId: user.id, tenantId: tenant.id };
}
```

## Public routes

Mark specific routes as public using the `@Public()` decorator. This overrides any global guard or route rule configuration:

```typescript
import { Controller, Get } from '@nestjs/common';
import { Public } from '@nebulr-group/bridge-nestjs';

@Controller()
export class AppController {
  @Get('health')
  @Public()
  healthCheck() {
    return { status: 'ok' };
  }
}
```

## API token authentication

The plugin supports API token authentication alongside user JWTs. API tokens are sent via the `x-api-key` header and carry their own privilege claims.

Use `@RequirePrivilege()` (API tokens only) for the scope an API token must carry, and `@AcceptAuth()` to restrict which auth types an endpoint accepts:

```typescript
import { Controller, Get, Req } from '@nestjs/common';
import { RequirePrivilege, AcceptAuth } from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';

@Controller('api/users')
export class ApiUsersController {
  // Accept both user JWTs and API tokens (default behavior)
  // API tokens only: an x-api-key caller must carry USER_READ. Not a gate on a person.
  @Get()
  @RequirePrivilege('USER_READ')
  listUsers(@Req() req: Request) {
    const apiToken = req.bridgeApiToken; // Set when using x-api-key
    const user = req.bridgeUser;         // Set when using Bearer token
    // ...
  }

  // Only accept API tokens; user JWTs get 401
  @Get('external')
  @AcceptAuth('api_token')
  @RequirePrivilege('USER_READ')
  externalList() {
    // ...
  }
}
```

For full API token documentation, see the [examples documentation](../examples/examples.md#api-token-authentication).

## Next steps

You now have backend authentication set up. The guard will:

1. Validate user JWTs from `Authorization: Bearer <token>` headers
2. Validate API tokens from `x-api-key` headers
3. Verify tokens against Bridge's JWKS endpoints
4. Attach user and tenant information to each request
5. Enforce flag requirements (people) and API-token scopes (machines)

For detailed examples including flag-gated endpoints, feature flags, API token patterns, GraphQL support, and multi-tenancy, see the [examples documentation](../examples/examples.md).
