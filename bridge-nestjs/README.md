# @nebulr-group/bridge-nestjs

Bridge NestJS plugin for authentication, role-based access control, and feature flags.

## Installation

```bash
npm install @nebulr-group/bridge-nestjs
```

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

```typescript
BridgeModule.forRoot({
  appId: 'your-app-id',
  guard: {
    global: true,
    defaultAccess: 'protected',
    rules: [
      { path: '/health', public: true },
      { path: '/admin/*', role: 'ADMIN' },
      { path: '/beta/*', featureFlag: 'beta-access' },
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

### Feature Flags

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

### Programmatic Feature Flag Checks

```typescript
import { FeatureFlagService } from '@nebulr-group/bridge-nestjs';

@Injectable()
export class ReportsService {
  constructor(private featureFlags: FeatureFlagService) {}

  async generateReport(accessToken: string) {
    const hasPdfExport = await this.featureFlags.isEnabled('pdf-export', accessToken);
    if (hasPdfExport) {
      return this.generatePdfReport();
    }
    return this.generateBasicReport();
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

## Decorators

| Decorator | Description |
|-----------|-------------|
| `@CurrentUser()` | Extract the authenticated user from the request |
| `@CurrentTenant()` | Extract the tenant from the request |
| `@RequireRole(role)` | Require a specific role |
| `@RequireFeatureFlag(flag)` | Require a feature flag (single, any, or all) |
| `@Public()` | Mark route as public (skip auth) |

## Configuration Options

```typescript
interface BridgeConfig {
  // Required
  appId: string;

  // Optional (with defaults)
  authBaseUrl?: string;        // default: 'https://auth.nblocks.cloud'
  backendlessBaseUrl?: string; // default: 'https://backendless.nblocks.cloud'
  debug?: boolean;             // default: false

  // Guard configuration
  guard?: {
    global?: boolean;                    // Enable global guard
    defaultAccess?: 'public' | 'protected'; // Default: 'protected'
    rules?: RouteRule[];                 // Centralized route rules
  };
}

interface RouteRule {
  path: string;                          // Path pattern (supports * wildcard)
  public?: boolean;                      // Mark as public
  role?: string;                         // Required role
  featureFlag?: string | { any: string[] } | { all: string[] };
  methods?: ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')[]; // HTTP methods
}
```

## Types

### BridgeUser

```typescript
interface BridgeUser {
  id: string;
  email: string;
  emailVerified: boolean;
  username: string;
  fullName: string;
  givenName?: string;
  familyName?: string;
  locale?: string;
  onboarded?: boolean;
  tenantId: string;
  role?: string;
  multiTenantAccess?: boolean;
}
```

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

`BridgeHttpService` is an injectable service for making HTTP calls to downstream NestJS services,
forwarding the authenticated user's token so the downstream service can also authenticate the user.

```typescript
import { Controller, Get, Req } from '@nestjs/common';
import { BridgeHttpService } from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';

@Controller('items')
export class ItemsController {
  constructor(private readonly bridgeHttpService: BridgeHttpService) {}

  @Get('from-service-b')
  async getFromServiceB(@Req() req: Request) {
    // Forwards the user's verified token to service-b
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

The guard sets `WWW-Authenticate` headers on 401 responses so clients can distinguish between
different error conditions and take the appropriate action:

| Condition | Error code | WWW-Authenticate header |
|---|---|---|
| No Authorization header | `missing_token` | `Bearer error="missing_token"` |
| Token expired | `expired_token` | `Bearer error="expired_token"` |
| Token invalid/tampered | `invalid_token` | `Bearer error="invalid_token"` |
| JWKS no matching key | `invalid_token` | `Bearer error="invalid_token"` |

Example response headers:
```
WWW-Authenticate: Bearer error="expired_token", error_description="The access token has expired"
```

Recommended client handling:
- `missing_token` → Redirect user to login
- `expired_token` → Attempt token refresh, then retry; redirect to login on failure
- `invalid_token` → Redirect user to login

### 401 Unauthorized

```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "message": "No authorization token was provided"
}
```

### 403 Forbidden (Role)

```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "Role 'ADMIN' required"
}
```

### 403 Forbidden (Feature Flag)

```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "Feature flag 'beta-access' is not enabled"
}
```

## License

MIT

