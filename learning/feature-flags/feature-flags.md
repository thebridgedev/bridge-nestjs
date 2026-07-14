---
title: Feature Flags
order: 40
oneLiner: Ship behind a flag and change who sees what — live from admin, no redeploy.
related: [auth, payments]
---

# Feature Flags

Bridge Feature Flags evaluates locally — the module keeps the flag rules in memory, evaluates against in-process context, and receives rule changes live over a push channel. A flag check is a synchronous O(1) lookup: no network call, no `await`, safe in hot request paths.

Flags work standalone: `BridgeFlagsModule` is auth-free and does not require any other Bridge module. Bridge auth and billing are optional context sources you can target on (see [Target by plan or role](/feature-flags/targeting/by-plan-or-role/)).

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

`forRootAsync` is available when the API key comes from `ConfigModule`. The module is `@Global()` — register once, inject anywhere. See [Get started](/feature-flags/get-started/) for the full walkthrough.

### BridgeFlagsService — evaluate a flag

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

`flag<T>(key, defaultValue, context?)` returns the evaluated value, typed from your default (`boolean` | `string` | `number` | JSON object). The default is mandatory — it's what you get when the flag isn't configured or Bridge is unreachable. A flag call can never break your app. See [Use flags in your logic](/feature-flags/using/in-logic/).

### @RequireFlag — gate a route

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { RequireFlag, BridgeFlagGuard } from '@nebulr-group/bridge-nestjs/flags';

@Controller('exports')
@UseGuards(BridgeFlagGuard)
export class ExportsController {
  @Get()
  @RequireFlag('exports_enabled')
  list() { /* … */ }
}
```

The guard rejects the request with a `403` before your handler runs when the flag is off. See [Guard routes](/feature-flags/using/guard-routes/).

### Identity on the backend

A server process is not "a user," so the SDK never invents an identity — you pass one per eval (or per request scope). **Percentage rollouts require identity**: if a rollout rule is active and no identity is passed, the SDK refuses the rollout and returns the safe default with a warning — it will not silently randomize per call. See [Send context from your backend](/feature-flags/targeting/send-context/) and [Target anonymous visitors](/feature-flags/targeting/anonymous/).

### Frontend context propagation

When your frontend also evaluates flags for the same user, both sides must agree on identity or their buckets split-brain. The frontend Bridge SDKs serialize the eval context into the `x-bridge-context` header; `BridgeContextInterceptor` reads it and binds it to the request automatically. See [Receiving forwarded context](/feature-flags/using/backend/).

### Bridge-managed attributes

To target rules on verified auth state (`bridge:user.role`, `bridge:tenant.plan`), register an `AuthAttributeProvider` that reads your verified JWT claims. Unlike the frontend SDKs, nothing about role or plan reaches the evaluator automatically on a backend — you wire the provider in. See [Target by plan or role](/feature-flags/targeting/by-plan-or-role/).

### Live rule updates

By default (`runtimeMode: 'channel'`) a long-running service holds a live WebSocket connection; flipping a flag, ramping a rollout, or hitting a kill switch in Control Center reaches every connected instance in about a second. Ephemeral runtimes (cron, serverless, webhook handlers) can use `runtimeMode: 'pull'` — a TTL-bounded REST cache instead of a socket. See [How flags work](/feature-flags/how-it-works/).

### Multi-type values

```typescript
const maxUploads = this.flags.flag('max_uploads', 10);                      // number
const mode       = this.flags.flag('pipeline_mode', 'stable');              // string
const rateLimit  = this.flags.flag('rate_limit', { window: 60, max: 100 }); // JSON
```

A type mismatch (admin stored a different type than your default suggests) returns the default and logs a warning.

---

### On-demand checks over the Bridge API

`@RequireFlag` / `BridgeFlagsService` (above) evaluate locally and receive live updates. If you'd rather not run a flags client — for simple route gating or an occasional check — `@RequireFeatureFlag` / `FeatureFlagService` from the main `@nebulr-group/bridge-nestjs` entry point evaluate flags on demand over the Bridge API instead, keyed on the user's access token, with a 5-minute per-token cache:

```typescript
@RequireFeatureFlag({ all: ['premium-tier', 'reports-v2'] })   // decorator
await this.featureFlags.isEnabled('pdf-export', accessToken);  // service, async, 5-min cache
```

`@RequireFeatureFlag` (with `any`/`all` requirement objects) and `FeatureFlagService.isEnabled / evaluateRequirement / bulkEvaluate` work with boolean flags. Reach for `@RequireFlag` / `BridgeFlagsService.flag()` when you want synchronous, multi-type, live-updating evaluation; reach for `@RequireFeatureFlag` / `FeatureFlagService` when you just need a quick boolean check and don't want to run a flags client. See [Gate features by role or privilege](/auth/roles/gate-with-flags/) for how the two mechanisms differ on role targeting.
