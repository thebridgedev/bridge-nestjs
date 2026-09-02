# Bridge NestJS — Feature Flags

You are adding **Feature Flags** to a NestJS application that uses The Bridge. The goal is to ship code behind a switch you control from outside the app — no redeploy needed.

On a backend there is no demo page to look at. The equivalent proof is a **guarded route whose HTTP status changes when you flip the flag**, so that is what this prompt builds.

## Decide first — which surface do you need?

Two unrelated decisions live in this prompt. Don't mix them up.

**A. Consuming a flag in application code** — the NestJS SDK surface:

| Goal | Use |
|---|---|
| Block a route unless a flag is on | `@RequireFlag('key')` on the method **plus** `@UseGuards(BridgeFlagGuard)` — the decorator is inert without the guard |
| Read a flag's value into a handler argument | `@Flag({ key, defaultValue })` param decorator (**one object argument**, not positional) |
| Branch on a flag inside a service or worker | `BridgeFlagsService.flag(key, defaultValue, context?)` — synchronous, never throws |

All three read the same in-memory cache, so the `hydrate()` call in Step 1 is a hard prerequisite for every one of them. Full signatures in **The gating surface** below.

**B. Configuring the flag on the platform** — creating it, setting its state, writing its rule. That is not code; it happens over MCP tools or the `bridge` CLI, with the dashboard only as a fallback. See **Step 3 → Where to configure it**.

## Prerequisites check

Before starting, verify:

1. `@nebulr-group/bridge-nestjs` is in `package.json` dependencies
2. You have your **Bridge app id** (`get_app` over MCP, `bridge app get` on the CLI, or the dashboard) available as an env var — this prompt calls it `BRIDGE_APP_ID`
3. You know your API base URL (`https://api.thebridge.dev` in prod; your local bridge-api otherwise) — this prompt calls it `BRIDGE_API_BASE_URL`
4. A root `AppModule` exists at `src/app.module.ts`

You do **not** need `BridgeModule.forRoot(...)` or Bridge Auth for flags. The flags entry point is deliberately auth-free — it pulls in no `BridgeAuthGuard`, no JWKS, no Bridge HTTP client.

If the package isn't installed or you can't find an app id, run `bridge guide nestjs` first.

> **Import path.** Import flags from `@nebulr-group/bridge-nestjs/flags` (requires >= 0.6.0). Earlier versions shipped no `exports` map, so that specifier threw `MODULE_NOT_FOUND` and this guide told you to reach into `@nebulr-group/bridge-nestjs/dist/flags` instead. Do not use that path in new code — it hard-codes the build layout into your imports and is deprecated (TBP-613).

## Step 1 — Activate the flags layer

Register `BridgeFlagsModule` once in the root `AppModule`. It is `@Global()`, so `BridgeFlagsService` injects anywhere afterwards.

Two things are needed, and **the second is not optional**: the module constructs an *empty* flag cache. Nothing in the SDK bulk-loads it. Until you hydrate, every read returns your default.

```ts
// src/app.module.ts
import { Module, type OnModuleInit } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  BridgeFlagsModule,
  BridgeFlagsService,
  BridgeContextInterceptor,
  type CachedFlag,
} from '@nebulr-group/bridge-nestjs/flags';

@Module({
  imports: [
    BridgeFlagsModule.forRoot({
      apiBaseUrl: process.env.BRIDGE_API_BASE_URL!,
      apiKey: process.env.BRIDGE_APP_ID!,
    }),
  ],
  providers: [{ provide: APP_INTERCEPTOR, useClass: BridgeContextInterceptor }],
})
export class AppModule implements OnModuleInit {
  constructor(private readonly flags: BridgeFlagsService) {}

  // Load the rule set once at boot. Without this the in-memory cache is empty
  // and every flag read returns its default until a live update happens to
  // arrive over the websocket.
  async onModuleInit(): Promise<void> {
    const base = process.env.BRIDGE_API_BASE_URL!.replace(/\/+$/, '');
    const appId = encodeURIComponent(process.env.BRIDGE_APP_ID!);
    try {
      const res = await fetch(`${base}/admin/flags-internal/flags-cache/${appId}`);
      if (res.ok) this.flags.hydrate((await res.json()) as CachedFlag[]);
    } catch {
      // Best-effort: a failed hydrate must never block boot. Reads fall back
      // to their defaults.
    }
  }
}
```

`forRootAsync({ imports, inject, useFactory })` is available when the config comes from `ConfigModule`.

`apiKey` is sent as the `x-api-key` header to the realtime and telemetry endpoints, and is the same value every other Bridge SDK passes there: your **app id**.

## Step 2 — Your first flag: a route that flips

Create a controller gated on a flag. `@RequireFlag` is inert on its own — the metadata only takes effect when `BridgeFlagGuard` runs, so apply both.

```ts
// src/flags-demo/flags-demo.controller.ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { RequireFlag, BridgeFlagGuard, Flag } from '@nebulr-group/bridge-nestjs/flags';

@Controller('flags-demo')
@UseGuards(BridgeFlagGuard)
export class FlagsDemoController {
  // 403 while `demo-flag` is off; 200 once it is on.
  @Get('gated')
  @RequireFlag('demo-flag')
  gated() {
    return { gated: true };
  }

  // Always 200 — reports the current value instead of gating on it.
  @Get('value')
  value(@Flag({ key: 'demo-flag', defaultValue: false }) demo: boolean) {
    return { 'demo-flag': demo };
  }
}
```

Register `FlagsDemoController` in `AppModule`'s `controllers`, start the app, and prove it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/flags-demo/gated   # → 403
curl -s localhost:3000/flags-demo/value                                    # → {"demo-flag":false}
```

The flag is auto-created in Bridge as **off** the first time it is evaluated — discovery telemetry is emitted on first sight of an unknown key.

**After creating the files, tell the user:**

> I've added a flag-gated endpoint at `GET /flags-demo/gated`. It returns **403** right now. Flip **demo-flag** on and the same request starts returning **200**, with no redeploy — I can do that for you over MCP (`toggle_feature_flag`) or the CLI (`bridge flag toggle`), or you can toggle it yourself under **Feature Control** in the dashboard. `GET /flags-demo/value` shows the raw value.

## The gating surface

| Surface | Signature | Notes |
|---|---|---|
| `@RequireFlag` | `RequireFlag(key, defaultValue = false, options?)` | Method or class decorator. Needs `BridgeFlagGuard` to do anything |
| `options.equals` | `unknown` | Compare a non-boolean flag against a specific value. Defaults to `true` |
| `options.optional` | `boolean` | See caveat below |
| `BridgeFlagGuard` | `@UseGuards(BridgeFlagGuard)` | Reads the metadata, evaluates, throws `ForbiddenException` on a miss |
| `@Flag` | `@Flag({ key, defaultValue })` | Param decorator — **single object argument**, not positional |
| `useFlagParam` | `useFlagParam<T>(key, defaultValue)` | Wraps `@Flag` so the generic survives: `const ShowNew = useFlagParam<boolean>('show-new', false)` |
| `BridgeFlagsService.flag` | `flag<T>(key, defaultValue, context?): T` | Synchronous, never throws. `T` is inferred from the default |

```ts
// Gate on a specific value of a string flag:
@Get('beta')
@RequireFlag('export-mode', 'v1', { equals: 'v2' })
betaExport() {}
```

Pass logic in the guard: the value passes when it equals `options.equals`, or — for the default boolean case — when it is merely truthy.

**Caveat on `options.optional`.** The source intends "skip the guard instead of rejecting", but the implementation returns `false` from `canActivate`, which Nest turns into a 403 with its generic message. Today it rejects either way; only the error body differs. Don't rely on it to let a request through.

**Programmatic reads** — same evaluation, no decorator:

```ts
@Injectable()
export class ReportsService {
  constructor(private readonly flags: BridgeFlagsService) {}

  generate(userId: string) {
    // Synchronous: local eval against the in-memory cache. No await, no network.
    if (this.flags.flag('use-new-pipeline', false, { identity: userId })) return this.v2();
    return this.v1();
  }
}
```

The default is mandatory and it types the call: `flag('max-uploads', 10)` is a `number`, `flag('rate-limit', { window: 60 })` is that object shape. If the stored value's type doesn't match the default's, the default is returned.

## Step 3 — Configure how the flag decides (states and rules)

A flag has exactly **three states**. `off` and `on` apply to everyone; `on-with-rule` decides per identity.

| State | Meaning |
|---|---|
| `off` | Everyone gets the off value. A newly auto-created flag starts here |
| `on` | Everyone gets the on value |
| `on-with-rule` | The rule decides. Whoever matches a branch gets that branch's value; everyone else gets `otherwiseValue` |

A rule is **branches + otherwiseValue + rolloutPct**, first match wins:

```jsonc
{
  "branches": [
    { "conditions": [ { "attribute": "tenant.plan", "operator": "in", "values": ["pro", "enterprise"] } ],
      "returnValue": true }
  ],
  "otherwiseValue": false,
  "rolloutPct": 100          // 0-100, applies to the WHOLE rule
}
```

- Conditions inside one branch are AND-ed; add more branches for OR / different return values.
- Operators: `eq` `neq` `contains` `not_contains` `in` `not_in` `gt` `lt` `between` `regex` `exists` `not_exists` (numeric and date operators only apply to those attribute types).
- `attribute` is a dotted path into the eval context (next step). With Bridge Auth, `user.id` `user.role` `user.email` `tenant.id` `tenant.plan` are the canonical paths.
- **`rolloutPct` below 100 requires an identity** on the eval context — bucketing is `hash(flagKey + identity) mod 100`. With no identity the SDK refuses to bucket and returns the safe value rather than randomizing per call.

### Where to configure it — MCP, CLI, or dashboard

Bridge exposes flag configuration over **two channels an agent can drive**, and they hit the same management API, so the result is identical:

| | Channel | Surface |
|---|---|---|
| **MCP** | Bridge MCP server | `list_feature_flags`, `create_feature_flag`, `update_feature_flag`, `toggle_feature_flag` |
| **CLI** | `bridge` | `bridge flag list \| get \| create \| update \| toggle \| eval` |

**Use whichever you actually have.** If the user asked for a specific one, use that one — no reason to argue, both reach the same API. If you have both and the user expressed no preference, either is correct; pick one and stay on it for the whole task so you aren't reasoning about two views of the same state.

The **dashboard (Feature Control) is a last resort**, not a third equal option. Only walk the user through the UI when neither MCP nor CLI is available *and* they don't want to install one.

Creating the flag from the rule above, in either channel:

```jsonc
// MCP — create_feature_flag
{
  "key": "enterprise-export",
  "valueType": "boolean",
  "state": "on-with-rule",
  "rule": {
    "branches": [
      { "conditions": [ { "attribute": "tenant.plan", "operator": "in", "values": ["pro", "enterprise"] } ],
        "returnValue": true }
    ],
    "otherwiseValue": false,
    "rolloutPct": 100
  }
}
```

```bash
# CLI — same flag
bridge flag create --key enterprise-export --value-type boolean --state on-with-rule \
  --rule '{"branches":[{"conditions":[{"attribute":"tenant.plan","operator":"in","values":["pro","enterprise"]}],"returnValue":true}],"otherwiseValue":false,"rolloutPct":100}'
```

**Flipping a flag on or off**, without touching its rule — the channels differ here, and it costs you a round-trip:

| Channel | Call | Lookup needed |
|---|---|---|
| MCP | `toggle_feature_flag` with `{ key, enabled }` | **None** — it resolves the key to an id itself. One call |
| CLI | `bridge flag toggle --id <id> --enabled true` | Yes — `bridge flag toggle` and `bridge flag update` both key off the flag's **id**, not its key. Run `bridge flag list` first |

```bash
bridge flag update --id <id> --state on      # or --state off | on-with-rule
```

For anything beyond plain on/off — rewriting the rule, changing values or `valueType` — use `update_feature_flag` / `bridge flag update`. Note that the MCP `update_feature_flag` also takes an `id` (from `list_feature_flags`); only `toggle_feature_flag` accepts the key.

Inspect current state with `list_feature_flags` (MCP) or `bridge flag list` / `bridge flag get <key>` (CLI).

**Gaps — where MCP has nothing today.** Say so rather than improvising:

- **`bridge flag eval` has no MCP equivalent.** There is no tool that dry-runs a rule against a synthetic context. Over MCP, verify by reading the stored rule back with `list_feature_flags` and checking it says what you meant; the real verdict then comes from issuing a request against the running app. If you need the dry-run itself, that is a CLI-only capability:
  ```bash
  bridge flag eval enterprise-export --identity user-123 --attribute tenant.plan=pro   # → true
  bridge flag eval enterprise-export --identity user-123 --attribute tenant.plan=free  # → false
  ```
- **Deleting a flag, scheduling a state change, and bulk export/import are CLI-only** (`bridge flag delete`, `bridge flag schedule set|clear`, `bridge flag export|import`). No MCP tools exist for these.

## Step 4 — Feed the rule its inputs (eval context)

Rules can only target what the process sends. This is the crux on a backend: a server is not "a user", so **the SDK never invents an identity** — you supply one per request or per call.

```ts
{
  identity?: string;                    // stable per-user id — required when rolloutPct < 100
  attributes: Record<string, unknown>;  // dotted or nested; whatever your rules target
}
```

There are exactly three sources, lowest precedence first:

**1. Module-global context** — set once, applies to every eval in the process. Right for system-level attributes (region, deployment, version):

```ts
BridgeFlagsModule.forRoot({
  apiBaseUrl, apiKey,
  initialContext: { attributes: { region: process.env.AWS_REGION ?? 'local' } },
  serverInstanceId: serverInstanceId(),   // exported from the flags barrel
});
// …or later: this.flags.setContext({ attributes: { region } }, /* merge */ true);
```

**2. Per-request context, via `BridgeContextInterceptor`** — this is the mechanism for user-scoped evals. Registered as an `APP_INTERCEPTOR` in Step 1, it runs on every request and, in order:

- reads the `x-bridge-context` header (constant `BRIDGE_CONTEXT_HEADER`) — a base64url JSON envelope the **frontend** Bridge SDK writes with `serializeContext(ctx)` — and decodes it with `deserializeContext`;
- takes `identity` from that header, falling back to `req.bridgeUser.id`, then `req.user.id` (so an upstream auth guard supplies it when there is no header);
- takes `attributes` **from the header only**;
- stores the result at `req.bridgeFlagsContext`, and puts the raw `BridgeFlags` instance at `req.bridgeFlags` so `@Flag(...)` can reach it.

`BridgeFlagGuard` and `@Flag` both read `req.bridgeFlagsContext`. That is what makes frontend and backend bucket the same user identically instead of split-braining. A missing or malformed header is a silent no-op — the request still works, it just evaluates against the module-global context.

**3. Per-call context** — highest precedence, wins on key collision:

```ts
this.flags.flag('feature-x', false, { identity: req.bridgeUser.id });        // on behalf of a user
this.flags.flag('new-pipeline', false, { identity: tenantId });               // sticky per tenant
this.flags.flag('worker-v2', false, { attributes: { queue: 'billing' } });    // system-level
```

**Security rule:** the propagated header is client-controlled. It carries identity and custom attributes only — **never trust a client-sent `user.role` / `tenant.plan`.** If your rules target those, populate them yourself from verified JWT claims (`setContext` on a request-scoped provider, or the per-call `attributes`). This SDK does **not** auto-register `AuthAttributeProvider`; nothing wires your JWT into the eval context for you.

## How server-side evaluation actually works

This is the part that differs most from the browser SDKs, and it is the point of using flags on NestJS at all.

- **Evaluation is local and synchronous.** `BridgeFlagsModule.forRoot` builds one `BridgeFlags` instance holding a `Map` of `{ key, state, valueType, offValue, onValue, rule }`. `flag()` looks up the key, merges context, and runs the rule evaluator in-process. No HTTP on the read path, no `await`, safe in a hot request handler. Evaluation logic is the *same* module bridge-api uses server-side, so a CLI `flag eval` and a live request agree.
- **Backend mode is the default** (`mode: 'backend'`). Its one behavioural difference: when a flag is `on-with-rule` and the eval context has **no identity**, the SDK returns your default and warns once per key, instead of bucketing an anonymous user.
- **The cache is filled by you, then kept fresh by push.** The module does **not** fetch flags on boot — hence the `hydrate()` call in Step 1. After that, in the default `runtimeMode: 'channel'`, a `RealtimeClient` opens a websocket and applies `flag.updated` / `flag.removed` messages to the cache as admins change things. That is your live-update path, and it is incremental only: it never re-sends the full set.
- **Unknown key → default + discovery.** A key not in the cache returns your default and fires a one-shot discovery event so Bridge creates the flag record (as `off`).
- **Telemetry is batched** to `/v1/flags/eval-events`, `/v1/flags/discover`, `/v1/flags/call-sites`. Disable it with `telemetry: { enabled: false }` in tests or offline.
- **Teardown** happens on `onModuleDestroy` — the service stops realtime and telemetry.

### `runtimeMode: 'pull'` — read this before using it

```ts
BridgeFlagsModule.forRoot({ apiBaseUrl, apiKey, runtimeMode: 'pull', pullCache: { ttlMs: 30_000 } });
```

`'pull'` is meant for ephemeral runtimes (cron, serverless, webhook handlers, CLI scripts). It forces `realtime.enabled: false`, so **no websocket and therefore no live updates at all**, and registers a `BridgePullCache` under the `BRIDGE_PULL_CACHE` token.

**What is not supported today:** that pull cache is *not wired into flag reads*. It is a generic TTL cache exposed as an injectable; nothing in this SDK re-fetches the flag set through it. In pull mode the cache you hydrated at boot is the cache you keep for the process's lifetime. If a pull-mode process is long-lived, re-run the `flags-cache` fetch + `hydrate()` yourself on whatever cadence you need.

Also not supported: there is no `refresh()` on `BridgeFlagsService`, and no automatic re-hydrate after a websocket reconnect — a flag changed while the socket was down stays stale until the next `hydrate()`.

## Troubleshooting

- **`Cannot find module '@nebulr-group/bridge-nestjs/flags'`** — you are on bridge-nestjs < 0.6.0, which shipped no `exports` map. Upgrade. Do not work around it with `/dist/flags`; that path is deprecated (TBP-613).
- **Every flag returns its default, forever.** You didn't hydrate. Confirm the `flags-cache` fetch in `onModuleInit` returns a non-empty array, and that `apiBaseUrl` / `apiKey` (app id) are the ones for the workspace holding the flag.
- **`@RequireFlag` has no effect.** The decorator is only metadata. Add `@UseGuards(BridgeFlagGuard)` to the controller (or register it globally).
- **`@Flag(...)` always returns the default.** It reads `req.bridgeFlags`, which is set by `BridgeContextInterceptor` or by `BridgeFlagGuard`. On a route with neither, there is nothing to read. Register the interceptor globally.
- **`@Flag('key', false)` doesn't compile / misbehaves.** It takes one object: `@Flag({ key, defaultValue })`.
- **Rule never matches?** Run `bridge flag eval <key> --identity … --attribute k=v` to see the verdict with the app out of the way, then confirm the request actually carries those attributes — log `req.bridgeFlagsContext` in the handler. Over MCP there is no `eval` tool: read the rule back with `list_feature_flags` to confirm it stored what you meant, then compare it against the logged context.
- **`rolloutPct < 100` and the value never flips on.** No identity on the eval context. Backend mode refuses to bucket; look for the `[bridge.flag] '<key>': backend eval requires an explicit identity` warning.
- **A toggle (from any channel) doesn't reach the service.** Channel mode needs an outbound WebSocket; a proxy that blocks it leaves you on the cache you hydrated. Restart, or re-hydrate. In `runtimeMode: 'pull'` this is expected — there is no socket.
- **A `string`/`number` flag reads as its default.** Type mismatch between the stored value and the type your `defaultValue` implies — the SDK falls back to the default on purpose. Fix `--value-type` on the flag.

## Verify

1. **Build.** `npm run build` — no TypeScript or import errors.
2. **Hydrate.** Start the app; confirm the `flags-cache` fetch succeeded (log its length once if unsure). An empty cache invalidates every step below.
3. **Flag off (default).** `curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/flags-demo/gated` → **403**. `curl -s localhost:3000/flags-demo/value` → `{"demo-flag":false}`.
4. **Confirm it registered.** `list_feature_flags` (MCP) or `bridge flag list` (CLI) shows `demo-flag`, state `off` — it was auto-created by that first eval.
5. **Flip it on.** `toggle_feature_flag { key: 'demo-flag', enabled: true }` (MCP), or `bridge flag toggle --id <id> --enabled true` / `bridge flag update --id <id> --state on` with the id from step 4 (CLI). Dashboard only if you have neither.
6. **Observe the change.** Re-run the same two curls: **200**, and `{"demo-flag":true}` — with no redeploy and no restart, because the change arrived over the channel.
7. **Flip it back off** and confirm both revert.
8. **Targeting (if you wrote a rule).** On the CLI, `bridge flag eval <key> --identity user-123 --attribute tenant.plan=pro`; over MCP, re-read the rule with `list_feature_flags` (there is no eval tool). Either way, finish by issuing the request with that user's `x-bridge-context` header and confirming the endpoint agrees.

---

For anything this prompt doesn't cover — the older auth-coupled `@RequireFeatureFlag` / `FeatureFlagService` surface (root package, rides `BridgeAuthGuard`, evaluates over the Bridge API with a 5-minute per-token cache, booleans only), and its `{ any: [...] }` / `{ all: [...] }` forms — read `learning/feature-flags/feature-flags.md` rather than guessing an API.
