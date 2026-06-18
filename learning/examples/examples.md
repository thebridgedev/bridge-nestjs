# Examples

End-to-end, copy-pasteable examples for the Bridge NestJS plugin. Every snippet compiles against the
current API. For conceptual depth, follow the links to the topic guides.

- [Authentication & Access Control](../auth/auth.md)
- [Configuration](../configuration/configuration.md)
- [Feature Flags](../feature-flags/feature-flags.md)
- [Tenant Data — `BridgeService`](../bridge-service/bridge-service.md)
- [Multi-Tenancy](../multi-tenancy/multi-tenancy.md)
- [Frontend Integration](../frontend-integration/frontend-integration.md)
- [Error Handling](../error-handling/error-handling.md)

---

## 1. Module setup with a global guard

```typescript
import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';

@Module({
  imports: [
    BridgeModule.forRoot({
      appId: process.env.BRIDGE_APP_ID!,
      guard: {
        global: true,
        defaultAccess: 'protected',
        rules: [
          { path: '/health', privilege: 'ANONYMOUS' },
          { path: '/webhooks/*', privilege: 'ANONYMOUS' },
          { path: '/account/users', privilege: 'USER_READ' },
          { path: '/reports/*', privilege: 'TENANT_READ', plans: ['pro', 'enterprise'] },
        ],
      },
    }),
  ],
})
export class AppModule {}
```

Async variant (reading config from `@nestjs/config`):

```typescript
BridgeModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    appId: config.get('BRIDGE_APP_ID'),
    debug: config.get('BRIDGE_DEBUG') === 'true',
  }),
});
```

## 2. Reading the current user and tenant

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  BridgeAuthGuard,
  CurrentUser,
  CurrentTenant,
  BridgeUser,
  BridgeTenant,
} from '@nebulr-group/bridge-nestjs';

@Controller('me')
@UseGuards(BridgeAuthGuard)
export class MeController {
  @Get()
  whoAmI(@CurrentUser() user: BridgeUser, @CurrentTenant() tenant: BridgeTenant) {
    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      privileges: user.privileges, // ['AUTHENTICATED', 'USER_READ', ...]
      tenantId: tenant.id,
      tenantName: tenant.name,
    };
  }
}
```

## 3. Role-based access

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, RequireRole } from '@nebulr-group/bridge-nestjs';

@Controller('admin')
@UseGuards(BridgeAuthGuard)
@RequireRole('ADMIN')          // applies to the whole controller
export class AdminController {
  @Get('settings')
  @RequireRole('OWNER')        // tighter requirement for this route
  getSettings() { ... }
}
```

## 4. API tokens, privileges, and `@AcceptAuth`

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, RequirePrivilege, AcceptAuth } from '@nebulr-group/bridge-nestjs';

// Machine-to-machine endpoint: only an API token (x-api-key) is accepted.
@Controller('integrations/users')
@AcceptAuth('api_token')
@UseGuards(BridgeAuthGuard)
export class IntegrationUsersController {
  @Get()
  @RequirePrivilege('USER_READ')   // enforced for API tokens; user JWTs bypass @RequirePrivilege
  list() { ... }
}
```

## 5. Public routes

```typescript
import { Controller, Get } from '@nestjs/common';
import { Public } from '@nebulr-group/bridge-nestjs';

@Controller('health')
export class HealthController {
  @Get()
  @Public()
  check() {
    return { status: 'ok' };
  }
}
```

## 6. Feature flags

### Live-updating — `@RequireFlag` / `@Flag`

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeFlagGuard, RequireFlag, Flag } from '@nebulr-group/bridge-nestjs/flags';

@Controller('beta')
@UseGuards(BridgeFlagGuard)
export class BetaController {
  @Get('feature-x')
  @RequireFlag('feature_x')                         // 403 when the flag is off
  getFeatureX() { ... }

  @Get('home')
  home(@Flag({ key: 'show_new_home', defaultValue: false }) showNew: boolean) {
    // NOTE: @Flag takes ONE object argument { key, defaultValue } — not positional args.
    return showNew ? this.newHome() : this.oldHome();
  }
}
```

### On-demand — `@RequireFeatureFlag` + `FeatureFlagService`

```typescript
import { Controller, Get, Injectable } from '@nestjs/common';
import { RequireFeatureFlag, FeatureFlagService } from '@nebulr-group/bridge-nestjs';

@Controller('premium')
export class PremiumController {
  @Get()
  @RequireFeatureFlag({ all: ['premium-tier', 'active-subscription'] })
  getPremium() { ... }
}

@Injectable()
export class ReportsService {
  constructor(private readonly featureFlags: FeatureFlagService) {}

  async generate(accessToken: string) {
    return (await this.featureFlags.isEnabled('pdf-export', accessToken))
      ? this.generatePdf()
      : this.generateBasic();
  }
}
```

## 7. Tenant data — subscription & entitlement gating

```typescript
import { Controller, Get, Headers, ForbiddenException } from '@nestjs/common';
import { BridgeService } from '@nebulr-group/bridge-nestjs';

@Controller('reports')
export class ReportsController {
  constructor(private readonly bridge: BridgeService) {}

  @Get('export')
  async export(@Headers('authorization') auth: string) {
    const tenant = this.bridge.fromJwt(auth.replace(/^Bearer\s+/i, ''));

    if (!(await tenant.entitlements.can('pdf-export'))) {
      throw new ForbiddenException('Your plan does not include PDF export');
    }

    const sub = await tenant.subscription; // { plan: { slug, name }, status, endsAt?, gateEngaged? }
    return this.buildExport(sub.plan.slug);
  }
}
```

See [Tenant Data — `BridgeService`](../bridge-service/bridge-service.md) for the full reference.

## 8. Token forwarding between microservices

```typescript
import { Controller, Get, Req } from '@nestjs/common';
import { BridgeHttpService } from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';

@Controller('items')
export class ItemsController {
  constructor(private readonly http: BridgeHttpService) {}

  @Get('from-service-b')
  async getFromServiceB(@Req() req: Request) {
    // Forwards the verified user token so service-b authenticates the same user.
    return this.http.get('http://service-b/items', req.bridgeAccessToken);
  }
}
```

## 9. Public webhook handler (multi-tenant)

```typescript
import { Controller, Post, Body } from '@nestjs/common';
import { Public } from '@nebulr-group/bridge-nestjs';

@Controller('webhooks')
export class WebhooksController {
  @Post('bridge')
  @Public()                                  // webhooks carry no user JWT
  async handle(@Body() event: { type: string; tenantId: string }) {
    // Resolve tenant from the event payload, then act on it.
    return { received: true };
  }
}
```
