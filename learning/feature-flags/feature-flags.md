# Feature Flags

Feature flags are enforced via the `@RequireFeatureFlag()` decorator. Feature flags are **not** part of route rules — they are decorator-only.

### Single flag, any, and all requirements

```typescript
import { Controller, Get } from '@nestjs/common';
import { RequireFeatureFlag, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('features')
export class FeaturesController {
  // Single flag — must be enabled
  @Get('new-dashboard')
  @RequireFeatureFlag('beta-dashboard')
  getNewDashboard(@CurrentUser() user: BridgeUser) {
    return { dashboard: 'beta version' };
  }

  // ALL — every flag must be enabled
  @Get('premium-reports')
  @RequireFeatureFlag({ all: ['premium-tier', 'reports-v2'] })
  getPremiumReports(@CurrentUser() user: BridgeUser) {
    return { reports: 'premium data' };
  }

  // ANY — at least one flag must be enabled
  @Get('experimental')
  @RequireFeatureFlag({ any: ['beta-tester', 'internal-user'] })
  getExperimental(@CurrentUser() user: BridgeUser) {
    return { feature: 'experimental' };
  }
}
```

The `FeatureFlagRequirement` type:

```typescript
type FeatureFlagRequirement =
  | string                 // Single flag name
  | { any: string[] }     // At least one must be enabled
  | { all: string[] };    // All must be enabled
```

### Programmatic feature flag checks

Inject `FeatureFlagService` for runtime checks:

```typescript
import { Injectable } from '@nestjs/common';
import { FeatureFlagService } from '@nebulr-group/bridge-nestjs';

@Injectable()
export class ReportsService {
  constructor(private readonly featureFlags: FeatureFlagService) {}

  async generateReport(accessToken: string) {
    // Check single flag
    const hasPdfExport = await this.featureFlags.isEnabled('pdf-export', accessToken);

    // Check with requirement object
    const hasPremium = await this.featureFlags.evaluateRequirement(
      { all: ['premium-tier', 'active-subscription'] },
      accessToken,
    );

    // Bulk evaluate all flags for a user
    const allFlags = await this.featureFlags.bulkEvaluate(accessToken);
    // Returns Map<string, boolean>

    if (hasPdfExport) {
      return this.generatePdfReport();
    }
    return this.generateBasicReport();
  }
}
```

In a controller, get the access token from the request:

```typescript
import { Controller, Get, Req } from '@nestjs/common';
import { CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get()
  async getReport(
    @CurrentUser() user: BridgeUser,
    @Req() req: Request,
  ) {
    return this.reportsService.generateReport(req.bridgeAccessToken!);
  }
}
```

### Cache behavior

`FeatureFlagService` caches flag evaluations per access token with a 5-minute TTL. The first call for a user triggers a `bulkEvaluate` API call, which populates the cache for all flags. Subsequent calls within the TTL window are served from cache.

- `isEnabled(flag, token)` — checks cache, then bulk evaluates, then single-flag fallback
- `isEnabled(flag, token, true)` — bypasses cache (`forceLive` parameter)
- `clearCache()` — clears all cached flags
