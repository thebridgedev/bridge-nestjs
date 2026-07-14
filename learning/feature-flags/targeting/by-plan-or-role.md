# Target by plan or role

Targeting a flag on a user's role or a tenant's plan is one of the biggest
payoffs of building flags on Bridge — but on a backend there's one honest
difference from the frontend worth stating up front. In a browser SDK, if Bridge
auth is enabled, `user.role` and `tenant.plan` are already in every evaluation
with no app code. A NestJS process isn't a signed-in user, so **nothing about
role or plan reaches the evaluator automatically** — you wire it in once, with an
attribute provider that reads your already-verified JWT claims.

That's actually the safer default: the value can only come from a source *you*
trust, never from something a client handed you.

## Register an attribute provider

`AuthAttributeProvider` (from `@nebulr-group/bridge-auth-core`) takes a
synchronous `getClaims()` callback and flattens the returned JWT claims into
targeting attributes under the reserved `bridge:` namespace. Register it once at
bootstrap on the underlying bridge instance:

```typescript
import { AuthAttributeProvider } from '@nebulr-group/bridge-auth-core';
import { BridgeFlagsService } from '@nebulr-group/bridge-nestjs/flags';

// once at bootstrap — e.g. in an OnModuleInit
this.flags.bridge.registerAttributeProvider(
  new AuthAttributeProvider({ getClaims: () => getCurrentClaims() }),
);
```

The provider is consulted synchronously on every eval, so `getClaims()` must
return the *current* request's decoded claims (or `undefined` when there are
none). It maps claims into attributes like this:

| Attribute | Claim | Example values |
|---|---|---|
| `user.id` | `sub` | the signed-in user's id |
| `user.role` | `role` | `MEMBER`, `ADMIN`, `OWNER` (or your custom roles) |
| `user.email` | `email` | `jane@acme.com` |
| `tenant.id` | `tid` | the current workspace's ID |
| `tenant.plan` | `plan` | `FREE`, `PRO`, `ENTERPRISE` |
| `privileges` | `privileges` | the signed-in user's privilege list |

Because the provider lives under the `bridge:` namespace, a targeting rule
references these as `bridge:user.role`, `bridge:tenant.plan`, and so on. Any
dev-supplied attribute you pass on a `flag()` call wins on key collision, and the
admin UI surfaces the collision on the flag detail page.

## Read claims from a verified source only

`getClaims()` must read from a server-verified source — `req.bridgeUser` or
`req.bridgeApiToken`, populated by `BridgeAuthGuard` — and never from anything a
client supplied. This is the same "never trust client-sent role/plan attributes"
rule as forwarded context: a browser can put any `role` in the
`x-bridge-context` header, so plan/role targeting has to resolve from your own
JWT, not from the wire.

## Example: gate a feature by role

With the provider registered, an admin builds the rule once in Control Center —
*on for `bridge:user.role equals ADMIN`* — and your gated route just works, no
attribute-passing code at the call site:

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard } from '@nebulr-group/bridge-nestjs';
import { RequireFlag, BridgeFlagGuard } from '@nebulr-group/bridge-nestjs/flags';

@Controller('billing-settings')
@UseGuards(BridgeAuthGuard, BridgeFlagGuard) // auth first, so claims are populated
export class BillingSettingsController {
  @Get()
  @RequireFlag('billing_settings')
  get() { /* … */ }
}
```

## Example: gate a feature by plan

Same pattern for plan-gating a premium feature — the rule targets
`bridge:tenant.plan equals ENTERPRISE`:

```typescript
@Get('export')
@RequireFlag('export_reports')
exportReports() { /* … */ }
```

If you're gating something billing already grants access to, prefer targeting a
billing **entitlement** over the raw plan name — it survives plan renames and
custom per-tenant grants. See [Lock features to a plan](/billing/limits/lock-features/).

## When to reach for the legacy flag path instead

The main `@nebulr-group/bridge-nestjs` entry point also ships an older
`@RequireFeatureFlag` / `FeatureFlagService` that evaluates over the Bridge API,
keyed on the caller's access token — and because Bridge decodes that token
itself, role and plan targeting resolve with *no* provider wiring. If a
role-targeted rollout is all you need and you don't want a live flags client, that
path is less setup. See [Gate features by role or privilege](/auth/roles/gate-with-flags/)
for the full comparison.
