# Bridge NestJS Quickstart Guide

Get started with The Bridge NestJS plugin for backend authentication, privilege-based access control, API token support, and feature flags.

## Install the plugin

```bash
npm install @nebulr-group/bridge-nestjs
```

## Basic setup

Add `BridgeModule` to your application's root module with your `appId`:

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';

@Module({
  imports: [
    BridgeModule.forRoot({
      appId: 'YOUR_APP_ID',
    }),
  ],
})
export class AppModule {}
```

## Global guard with route rules

For most applications, enable the global guard with route rules. This protects all routes by default and lets you define exceptions using the `privilege` field:

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';

@Module({
  imports: [
    BridgeModule.forRoot({
      appId: 'YOUR_APP_ID',
      debug: true, // Enable for development
      guard: {
        global: true,
        defaultAccess: 'protected',
        rules: [
          // Public routes (no auth required)
          { path: '/health', privilege: 'ANONYMOUS' },
          { path: '/webhooks/*', privilege: 'ANONYMOUS' },

          // Require specific privileges
          { path: '/account/subscription/*', privilege: 'TENANT_WRITE' },
          { path: '/users/*', privilege: 'USER_READ' },

          // Restrict by subscription plan
        ],
      },
    }),
  ],
})
export class AppModule {}
```

All routes are now protected by default, with the exceptions you defined.

> **Note:** Role-based access (`@RequireRole()`) and feature flags (`@RequireFlag()` from `@nebulr-group/bridge-nestjs/flags`) are applied via decorators on controllers/routes, not in route rules. See the [feature flags documentation](../feature-flags/feature-flags.md) for details.

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

Use `@RequirePrivilege()` to enforce that an API token has a specific privilege, and `@AcceptAuth()` to restrict which auth types an endpoint accepts:

```typescript
import { Controller, Get, Req } from '@nestjs/common';
import { RequirePrivilege, AcceptAuth } from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';

@Controller('api/users')
export class ApiUsersController {
  // Accept both user JWTs and API tokens (default behavior)
  // API tokens must have USER_READ privilege; user JWTs bypass this check
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
5. Enforce privilege, role, and feature flag requirements

For detailed examples including role-based access, feature flags, API token patterns, GraphQL support, and multi-tenancy, see the [examples documentation](../examples/examples.md).
