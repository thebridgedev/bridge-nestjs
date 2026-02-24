# Bridge NestJS Quickstart Guide

This guide shows how to get started with The Bridge NestJS plugin for backend authentication, role-based access control, and feature flags.

## Install the plugin

Install The Bridge NestJS plugin:

```bash
npm install @nebulr-group/bridge-nestjs
```

## Configuration

### Basic Setup

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

### Global Guard with Route Rules

For most applications, you'll want to enable the global guard with route rules. This protects all routes by default and lets you define exceptions:

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
          // Public routes
          { path: '/health', public: true },
          { path: '/api/public/*', public: true },
          
          // Role-based routes
          { path: '/admin/*', role: 'ADMIN' },
          
          // Feature flag routes
          { path: '/beta/*', featureFlag: 'beta-access' },
        ],
      },
    }),
  ],
})
export class AppModule {}
```

You are now set up! All routes are protected by default, with the exceptions you defined.

## Authentication

### Accessing the Authenticated User

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
    return this.itemsService.findByTenant(user.tenantId);
  }
}
```

### Accessing Tenant Information

Use the `@CurrentTenant()` decorator to access tenant details:

```typescript
import { CurrentTenant, BridgeTenant } from '@nebulr-group/bridge-nestjs';

@Get()
findAll(
  @CurrentUser() user: BridgeUser,
  @CurrentTenant() tenant: BridgeTenant,
) {
  console.log('Tenant name:', tenant.name);
  return { userId: user.id, tenantId: tenant.id };
}
```

## Protecting Routes

### Using the Guard Per-Controller

If you don't want a global guard, you can apply protection per-controller:

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('items')
@UseGuards(BridgeAuthGuard)
export class ItemsController {
  @Get()
  findAll(@CurrentUser() user: BridgeUser) {
    return { message: 'Protected endpoint', user: user.email };
  }
}
```

### Public Routes with Decorator

Mark specific routes as public using the `@Public()` decorator:

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

## Wrap-up

You have now set up backend authentication with Bridge in your NestJS application! The guard will:

1. Validate JWT tokens from the `Authorization: Bearer <token>` header
2. Verify tokens against Bridge's JWKS endpoint
3. Attach user and tenant information to each request
4. Enforce role and feature flag requirements

For more detailed examples including role-based access and feature flags, please refer to the [examples documentation](../examples/examples.md).

