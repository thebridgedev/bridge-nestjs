# Bridge NestJS — Feature Flags

You are adding **Feature Flags** to a NestJS application that uses The Bridge. The goal is to ship code behind a switch you control from the Bridge dashboard — no redeploy needed.

There are **two ways to check flags — pick by whether you need live updates:**

- **`@RequireFlag` / `@Flag` / `useFlagParam`** (imported from `@nebulr-group/bridge-nestjs/flags`, backed by the BridgeFlags client via `BridgeFlagsModule` / `BridgeFlagsService`). Flags evaluate against a **local BridgeFlags client** that can **subscribe to live updates**: the module keeps the rule set in memory, evaluates against in-process context, and receives changes live. A check is a synchronous O(1) lookup — no network call, no `await`, safe in hot request paths. Auth-free: it does **not** require `BridgeModule` or any guard. **Use when you want live updates or to read a flag value** (not just gate). `@Flag({ key, defaultValue })` injects a flag value into a handler param. A good default.
- **`@RequireFeatureFlag` / `FeatureFlagService`** (imported from the package root, runs on `BridgeAuthGuard`). Evaluates flags **on demand over the Bridge API** with a short (5-minute) in-memory cache; **no live updates**. **Use for simple route gating or occasional checks when you don't want to run a flags client.**

## Prerequisites

For the `@RequireFlag` / `BridgeFlagsService` path you only need `@nebulr-group/bridge-nestjs` installed and a **workspace API key** (a JWT-shaped key for your Bridge app — get it from `bridge app get` or the dashboard). Auth setup (`BridgeModule.forRoot`) is **not** required for these flags — the `/flags` subpath is intentionally auth-free so apps running a standalone flags client don't pull in `BridgeAuthGuard`, JWKS, or the HTTP client.

---

## Live-updating flags — `@RequireFlag` / `BridgeFlagsService`

### Step 1 — Register `BridgeFlagsModule`

`@nebulr-group/bridge-nestjs/flags` is a subpath export — no new package to install. Register the module once in your root `AppModule`; it is `@Global()`, so inject anywhere.

```ts
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

`forRootAsync({ imports, inject, useFactory })` is available when the key comes from `ConfigModule`.

**Runtime mode.** Defaults to `'channel'` — a live WebSocket keeps rules current, ideal for long-running services. For ephemeral runtimes (cron jobs, serverless, webhook handlers, CLI scripts) set `runtimeMode: 'pull'`: this skips the WebSocket and backs reads with a TTL-bounded REST cache (`BridgePullCache`, default 30s).

```ts
BridgeFlagsModule.forRoot({
  apiBaseUrl: 'https://api.thebridge.dev',
  apiKey: process.env.BRIDGE_API_KEY!,
  runtimeMode: 'pull',          // serverless / cron
});
```

### Step 2 — Programmatic checks with `BridgeFlagsService`

```ts
import { Injectable } from '@nestjs/common';
import { BridgeFlagsService } from '@nebulr-group/bridge-nestjs/flags';

@Injectable()
export class ReportsService {
  constructor(private readonly flags: BridgeFlagsService) {}

  generate(userId: string) {
    // Synchronous — local evaluation, no network call, no await.
    if (this.flags.flag('use_new_pipeline', false, { identity: userId })) {
      return this.generateV2();
    }
    return this.generateV1();
  }
}
```

`flag<T>(key, defaultValue, context?)` returns the evaluated value, typed from your default (`boolean` | `string` | `number` | JSON object). **The default is mandatory** — it's what you get when the flag isn't configured or Bridge is unreachable. A flag call can never throw or break the request.

Multi-type values:

```ts
const maxUploads = this.flags.flag('max_uploads', 10);                       // number
const mode       = this.flags.flag('pipeline_mode', 'stable');              // string
const rateLimit  = this.flags.flag('rate_limit', { window: 60, max: 100 }); // JSON
```

A type mismatch (admin stored a different type than your default implies) returns the default and logs a warning.

### Step 3 — Identity on the backend

A server process is not "a user," so the SDK never invents an identity — you pass one per eval:

```ts
this.flags.flag('feature_x', false, { identity: req.bridgeUser.id }); // on behalf of the user
this.flags.flag('new_pipeline', false, { identity: tenantId });        // sticky per-tenant
this.flags.flag('worker_v2_enabled', false);                           // system-level, no identity
```

**Percentage rollouts require identity.** If a rollout rule is active and no identity is passed, the SDK refuses to bucket and returns the safe default with a warning — it never randomizes per call.

### Step 4 — Gate routes with `@RequireFlag` + `BridgeFlagGuard`

The decorator only takes effect when the guard is applied. Compose the pair:

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { RequireFlag, BridgeFlagGuard } from '@nebulr-group/bridge-nestjs/flags';

@Controller('exports')
@UseGuards(BridgeFlagGuard)
export class ExportsController {
  @Get()
  @RequireFlag('exports_enabled')
  list() { /* 403 when exports_enabled is off */ }

  // Non-boolean flag — gate on a specific value:
  @Get('beta')
  @RequireFlag('export_mode', 'v1', { equals: 'v2' })
  betaExport() { /* runs only when export_mode === 'v2' */ }
}
```

`RequireFlag(key, defaultValue = false, options?)`:
- `options.equals` — gate a non-boolean flag on a specific value.
- `options.optional: true` — **skip** the guard instead of rejecting. Use for kill switches that disable a route without returning 403.

### Step 5 — Inject a flag value as a handler parameter with `@Flag`

`@Flag` is a parameter decorator. **It takes a single object argument** `{ key, defaultValue }` — not positional args:

```ts
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

For a reusable typed param decorator, wrap with `useFlagParam<T>(key, defaultValue)`:

```ts
import { useFlagParam } from '@nebulr-group/bridge-nestjs/flags';

const ShowNewHome = useFlagParam<boolean>('show_new_home', false);

@Get('home')
home(@ShowNewHome() showNew: boolean) { /* ... */ }
```

`@Flag` reads from the per-request context populated by `BridgeContextInterceptor` (next step), falling back to the module's global context.

### Step 6 — Align identity with the frontend (`BridgeContextInterceptor`)

If your frontend also evaluates flags for the same user, both sides must agree on identity or buckets split-brain. The frontend Bridge SDKs send the eval context in the `x-bridge-context` header; register `BridgeContextInterceptor` so guard checks, `@Flag` params, and request-scoped evals reuse the same identity:

```ts
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BridgeContextInterceptor } from '@nebulr-group/bridge-nestjs/flags';

@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: BridgeContextInterceptor }],
})
export class AppModule {}
```

Missing or malformed headers are a no-op — the request falls back to the module's global context.

**Security rule:** the propagated context carries identity and custom attributes only. **Never trust client-sent `role`/`plan` attributes** — read those from verified server-side sources (e.g. register an `AuthAttributeProvider` from auth-core that reads your verified JWT claims, so rules can target `bridge:user.role` / `bridge:tenant.plan`).

---

## On-demand flags — `@RequireFeatureFlag` / `FeatureFlagService`

Use this path for simple route gating or occasional checks when you don't want to run a flags client. It does not receive live updates.

This path is exported from the **package root** and rides on `BridgeAuthGuard` (so it requires `BridgeModule` and an authenticated user). Flags are evaluated on demand over the Bridge API against the user's access token, with a 5-minute per-token in-memory cache.

```ts
import { Controller, Get } from '@nestjs/common';
import { RequireFeatureFlag } from '@nebulr-group/bridge-nestjs';

@Controller('reports')
export class ReportsController {
  @Get('beta')
  @RequireFeatureFlag('beta-access')
  beta() {}

  @Get('premium')
  @RequireFeatureFlag({ all: ['premium-tier', 'active-subscription'] })
  premium() {}

  @Get('experimental')
  @RequireFeatureFlag({ any: ['beta-tester', 'internal-user'] })
  experimental() {}
}
```

`@RequireFeatureFlag(requirement)` accepts a single flag string, `{ any: string[] }` (at least one enabled), or `{ all: string[] }` (all enabled). It is enforced by `BridgeAuthGuard` via `FeatureFlagService`, which POSTs to cloud-views `bulkEvaluate`.

Programmatic checks via `FeatureFlagService` (async):

```ts
import { Injectable } from '@nestjs/common';
import { FeatureFlagService } from '@nebulr-group/bridge-nestjs';

@Injectable()
export class PdfService {
  constructor(private readonly flags: FeatureFlagService) {}

  async export(accessToken: string) {
    if (await this.flags.isEnabled('pdf-export', accessToken)) {
      return this.exportPdf();
    }
    return this.exportPlain();
  }
}
```

`FeatureFlagService.isEnabled(flag, accessToken, forceLive?)` — `forceLive: true` bypasses the 5-minute cache. `evaluateRequirement(requirement, accessToken)` evaluates a single/`any`/`all` requirement. Boolean flags only.

---

## Checklist

- [ ] **Live-updating path:** `BridgeFlagsModule.forRoot({ apiBaseUrl, apiKey })` registered (with `runtimeMode: 'pull'` for ephemeral runtimes)
- [ ] **Live-updating path:** programmatic checks use `BridgeFlagsService.flag(key, default, { identity })` and always pass a default
- [ ] **Live-updating path:** route gates use `@RequireFlag` **with** `@UseGuards(BridgeFlagGuard)`
- [ ] **Live-updating path:** `@Flag({ key, defaultValue })` uses the single-object form
- [ ] **Live-updating path:** `BridgeContextInterceptor` registered if the frontend also evaluates flags; never trust client-sent role/plan
- [ ] **On-demand path:** `@RequireFeatureFlag` / `FeatureFlagService` used for simple boolean route gating without a flags client

## Verify

1. **Build:** the project builds with no TypeScript or import errors.
2. **Flag off (default):** a `@RequireFlag('exports_enabled')` route returns 403; the flag is auto-created as off in the dashboard on first eval.
3. **Toggle on:** enable the flag in **Feature Control** in the Bridge dashboard — the route returns 200 without a redeploy (channel mode picks up the change live; pull mode within the cache TTL).
4. **Param value:** a handler reading `@Flag({ key, defaultValue })` reflects the dashboard value on the next request.
