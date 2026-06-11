# Feature Flags

Bridge Feature Flags evaluates locally — the module keeps the flag rules in memory, evaluates against in-process context, and receives rule changes live. A flag check is a synchronous O(1) lookup: no network call, no `await`, safe in hot request paths.

Flags work standalone: `BridgeFlagsModule` is auth-free and does not require any other Bridge module.

### Setup

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { BridgeFlagsModule } from '@nebulr-group/bridge-nestjs/flags';

@Module({
  imports: [
    BridgeFlagsModule.forRoot({
      apiBaseUrl: 'https://api.thebridge.dev',
      apiKey: process.env.BRIDGE_API_KEY!,
    }),
  ],
})
export class AppModule {}
```

`forRootAsync` is available when the API key comes from `ConfigModule`. The module is `@Global()` — register once, inject anywhere.

### Programmatic checks — BridgeFlagsService

```typescript
import { Injectable } from '@nestjs/common';
import { BridgeFlagsService } from '@nebulr-group/bridge-nestjs/flags';

@Injectable()
export class ReportsService {
  constructor(private readonly flags: BridgeFlagsService) {}

  generate(userId: string) {
    // Synchronous — local evaluation, no network call
    if (this.flags.flag('use_new_pipeline', false, { identity: userId })) {
      return this.generateV2();
    }
    return this.generateV1();
  }
}
```

`flag<T>(key, defaultValue, context?)` returns the evaluated value, typed from your default (`boolean` | `string` | `number` | JSON object). The default is mandatory — it's what you get when the flag isn't configured or Bridge is unreachable. A flag call can never break your app.

### Identity on the backend

A server process is not "a user," so the SDK never invents an identity — you pass one per eval (or per request scope):

```typescript
// On behalf of the requesting user
this.flags.flag('feature_x', false, { identity: req.user.id });

// Sticky per-tenant behavior (webhooks, queues)
this.flags.flag('new_pipeline', false, { identity: tenantId });

// System-level flag, no identity
this.flags.flag('worker_v2_enabled', false);
```

**Percentage rollouts require identity.** If a rollout rule is active and no identity is passed, the SDK refuses the rollout and returns the safe default with a warning — it will not silently randomize per call.

### Route guards — @RequireFlag

Gate handlers on a flag with the guard + decorator pair:

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { RequireFlag, BridgeFlagGuard } from '@nebulr-group/bridge-nestjs/flags';

@Controller('exports')
@UseGuards(BridgeFlagGuard)
export class ExportsController {
  @Get()
  @RequireFlag('exports_enabled')
  list() { /* … */ }

  // Non-boolean flags: gate on a specific value
  @Get('beta')
  @RequireFlag('export_mode', 'v1', { equals: 'v2' })
  betaExport() { /* … */ }
}
```

`RequireFlag(key, defaultValue = false, options?)` — `options.equals` gates non-boolean flags on a specific value; `options.optional: true` skips the guard instead of rejecting (useful for kill switches that should disable a route without 403'ing).

### Flag values as handler parameters — @Flag

```typescript
import { Controller, Get } from '@nestjs/common';
import { Flag } from '@nebulr-group/bridge-nestjs/flags';

@Controller('home')
export class HomeController {
  @Get()
  home(@Flag({ key: 'show_new_home', defaultValue: false }) showNew: boolean) {
    return showNew ? this.newHome() : this.classicHome();
  }
}
```

For typed reusable params, wrap with `useFlagParam<T>(key, defaultValue)`.

### Frontend context propagation — BridgeContextInterceptor

When your frontend also evaluates flags for the same user, both sides must agree on identity or buckets split-brain. The frontend Bridge SDKs send the eval context in the `x-bridge-context` header; `BridgeContextInterceptor` reads it and binds it to the request, so guard checks, `@Flag` params, and request-scoped evals automatically use the same identity the frontend used:

```typescript
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BridgeContextInterceptor } from '@nebulr-group/bridge-nestjs/flags';

@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: BridgeContextInterceptor }],
})
export class AppModule {}
```

Missing or malformed headers are a no-op — the request falls back to the module's global context.

**Security rule:** the propagated context should carry identity and custom attributes only. Never trust client-sent `role`/`plan` attributes — read those from server-side sources (see attribute providers below).

### Bridge-managed attributes

To target rules on verified auth state (`bridge:user.role`, `bridge:tenant.plan`), register an `AuthAttributeProvider` that reads your verified JWT claims:

```typescript
import { AuthAttributeProvider } from '@nebulr-group/bridge-auth-core';

// once at bootstrap
this.flags.bridge.registerAttributeProvider(
  new AuthAttributeProvider({ getClaims: () => getCurrentClaims() }),
);
```

Providers are consulted synchronously on every eval; dev-supplied attributes win on key collision (the admin UI surfaces collisions).

### Pull mode

Runtimes that can't hold a live connection can use the pull cache (`BridgePullCache`, default TTL 30 s) — inject via `@Inject(BRIDGE_PULL_CACHE)`. Evals stay local; the rule set refreshes by polling instead of push.

### Multi-type values

```typescript
const maxUploads = this.flags.flag('max_uploads', 10);                       // number
const mode       = this.flags.flag('pipeline_mode', 'stable');               // string
const rateLimit  = this.flags.flag('rate_limit', { window: 60, max: 100 }); // JSON
```

A type mismatch (admin stored a different type than your default suggests) returns the default and logs a warning.

---

### Legacy (1.x) API

The pre-2.0 surface was server-evaluated and token-based:

```typescript
@RequireFeatureFlag({ all: ['premium-tier', 'reports-v2'] })   // decorator
await this.featureFlags.isEnabled('pdf-export', accessToken);  // service, async, 5-min cache
```

`RequireFeatureFlag` (with `any`/`all` requirement objects), `FeatureFlagService.isEnabled/evaluateRequirement/bulkEvaluate`, and the per-token 5-minute cache remain available for boolean flags during migration. New code should use `@RequireFlag` / `BridgeFlagsService.flag()` — synchronous, multi-type, live-updating, and no cache TTL to reason about.
