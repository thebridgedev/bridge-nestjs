# Authentication & Access Control

## Authentication

### Accessing user information

Use the `@CurrentUser()` decorator to access the authenticated user:

```typescript
import { Controller, Get } from '@nestjs/common';
import { CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('users')
export class UsersController {
  @Get('me')
  getProfile(@CurrentUser() user: BridgeUser) {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      fullName: user.fullName,
      tenantId: user.tenantId,
      appId: user.appId,
      role: user.role,
      privileges: user.privileges,
      onboarded: user.onboarded,
    };
  }
}
```

The `BridgeUser` interface:

```typescript
interface BridgeUser {
  id: string;                    // User ID (sub claim)
  email: string;                 // User's email
  emailVerified: boolean;
  username: string;              // preferred_username claim
  fullName: string;              // Display name
  givenName?: string;
  familyName?: string;
  locale?: string;
  onboarded?: boolean;
  tenantId: string;              // Tenant/workspace ID
  appId?: string;                // App ID from the token (aid claim)
  scope?: string;                // OAuth scopes granted to the token
  role?: string;                 // User's role within the tenant
  multiTenantAccess?: boolean;
  privileges?: string[];         // Privilege strings (e.g. ['AUTHENTICATED', 'USER_READ'])
}
```

### Accessing workspace information

Use the `@CurrentTenant()` decorator to access details about the user's workspace (called a *tenant* in the API):

```typescript
import { Controller, Get } from '@nestjs/common';
import { CurrentUser, CurrentTenant, BridgeUser, BridgeTenant } from '@nebulr-group/bridge-nestjs';

@Controller('workspace')
export class WorkspaceController {
  @Get()
  getWorkspace(
    @CurrentUser() user: BridgeUser,
    @CurrentTenant() tenant: BridgeTenant,
  ) {
    return {
      user: { id: user.id, email: user.email, role: user.role },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        locale: tenant.locale,
        logo: tenant.logo,
        onboarded: tenant.onboarded,
      },
    };
  }
}
```

The `BridgeTenant` interface:

```typescript
interface BridgeTenant {
  id: string;
  name: string;
  locale?: string;
  logo?: string;
  onboarded?: boolean;
}
```

### Per-route vs global protection

#### Global guard (recommended)

Enable the global guard in your module configuration:

```typescript
BridgeModule.forRoot({
  appId: 'YOUR_APP_ID',
  guard: {
    global: true,
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/webhooks/*', privilege: 'ANONYMOUS' },
    ],
  },
})
```

With the global guard enabled, use `@Public()` to mark exceptions:

```typescript
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

#### Per-controller guard

Apply the guard to specific controllers:

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('items')
@UseGuards(BridgeAuthGuard)
export class ItemsController {
  @Get()
  findAll(@CurrentUser() user: BridgeUser) {
    return { message: 'Protected', user: user.email };
  }
}
```

#### Per-route guard

Apply the guard to specific routes:

```typescript
@Controller('items')
export class ItemsController {
  @Get()
  findAll() {
    return { message: 'Public endpoint' };
  }

  @Get('private')
  @UseGuards(BridgeAuthGuard)
  findPrivate(@CurrentUser() user: BridgeUser) {
    return { message: 'Protected endpoint', user: user.email };
  }
}
```

---

## API Token Authentication

### How it works

The Bridge NestJS plugin supports two authentication paths:

1. **User JWT**: sent via the `Authorization: Bearer <token>` header. This is the standard path for browser-based users.
2. **API token**: sent via the `x-api-key` header as a JWT. This is for server-to-server communication and programmatic access.

The guard checks both headers. If an API token is present, it is verified by introspection: the guard POSTs the token to the Bridge, which checks both the signature and the backing record (not revoked, not expired) and returns the token's claims. Those verified claims are attached to `req.bridgeApiToken`. If only a Bearer token is present, the request follows the standard user JWT path, verified locally against Bridge's JWKS endpoint.

> **Backward compatibility:** User JWTs bypass the `@RequirePrivilege()` check. This ensures existing endpoints that add `@RequirePrivilege()` for API token enforcement don't break user JWT access.

### ApiTokenClaims type

When an API token is verified, `req.bridgeApiToken` is set with these claims:

```typescript
interface ApiTokenClaims {
  sub: string;              // Token subject identifier
  appId: string;            // App ID the token was issued for
  tenantId: string | null;  // Tenant ID (null for app-level tokens)
  type: 'api';              // Always 'api' for API tokens
  privileges: string[];     // Privilege strings (e.g. ['USER_READ', 'TENANT_WRITE'])
}
```

### RequirePrivilege decorator

Use `@RequirePrivilege()` to enforce that an API token has a specific privilege:

```typescript
import { Controller, Get } from '@nestjs/common';
import { RequirePrivilege } from '@nebulr-group/bridge-nestjs';

@Controller('users')
export class UsersController {
  @Get()
  @RequirePrivilege('USER_READ')
  listUsers() {
    // API tokens must have USER_READ privilege
    // User JWTs bypass this check (backward compatibility)
  }

  @Post()
  @RequirePrivilege('USER_WRITE')
  createUser() {
    // API tokens must have USER_WRITE privilege
  }
}
```

### AcceptAuth decorator

Use `@AcceptAuth()` to restrict which authentication type an endpoint accepts:

```typescript
import { AcceptAuth } from '@nebulr-group/bridge-nestjs';

// Only user JWTs accepted; API tokens get 401
@AcceptAuth('jwt')

// Only API tokens accepted; user JWTs get 401
@AcceptAuth('api_token')

// Both accepted (default when decorator is omitted)
@AcceptAuth('both')
```

The `AuthType` is `'jwt' | 'api_token' | 'both'`.

### Dual-auth endpoints

Endpoints that accept both user JWTs and API tokens (default behavior):

```typescript
import { Controller, Get, Req } from '@nestjs/common';
import { RequirePrivilege, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';

@Controller('users')
export class UsersController {
  @Get()
  @RequirePrivilege('USER_READ')
  listUsers(@CurrentUser() user: BridgeUser, @Req() req: Request) {
    if (req.bridgeApiToken) {
      // Authenticated via API token
      console.log('API token tenant:', req.bridgeApiToken.tenantId);
      console.log('API token privileges:', req.bridgeApiToken.privileges);
      return this.usersService.findAll();
    }

    // Authenticated via user JWT
    return this.usersService.findByTenant(user.tenantId);
  }
}
```

### API-token-only endpoints

Endpoints that only accept API tokens:

```typescript
@Controller('integrations')
export class IntegrationsController {
  @Post('sync')
  @AcceptAuth('api_token')
  @RequirePrivilege('TENANT_WRITE')
  syncData(@Req() req: Request) {
    const { tenantId, privileges } = req.bridgeApiToken!;
    return this.syncService.run(tenantId);
  }
}
```

### JWT-only endpoints

Endpoints that only accept user JWTs (reject API tokens):

```typescript
@Controller('account')
export class AccountController {
  @Get('profile')
  @AcceptAuth('jwt')
  getProfile(@CurrentUser() user: BridgeUser) {
    // Only accessible with a user JWT
    return { email: user.email, role: user.role };
  }
}
```

---

## Role-Based Access Control

Roles are enforced via the `@RequireRole()` decorator. Roles are **not** part of route rules; they are decorator-only.

### Controller-level and route-level usage

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, RequireRole, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('admin')
@UseGuards(BridgeAuthGuard)
@RequireRole('ADMIN') // All routes in this controller require ADMIN
export class AdminController {
  @Get('dashboard')
  getDashboard(@CurrentUser() user: BridgeUser) {
    return { message: 'Admin dashboard', admin: user.email };
  }

  @Get('settings')
  @RequireRole('OWNER') // Override: requires OWNER instead of ADMIN
  getSettings(@CurrentUser() user: BridgeUser) {
    return { settings: 'sensitive data' };
  }
}
```

### Overriding with decorators

Route-level decorators override controller-level decorators. The guard uses `getAllAndOverride` from NestJS Reflector, so the most specific decorator wins.
