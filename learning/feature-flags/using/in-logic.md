# Use flags in your logic

`BridgeFlagsService.flag()` returns a plain value — nothing about it is tied to
routing. You'll often use it to gate a whole endpoint (see
[Guard routes](/feature-flags/using/guard-routes/)), but it's just as much for
deciding *what to do* inside a service: which implementation handles a job, what
limit to enforce, which calculation to run. This page covers the `flag()` API
itself.

## flag — evaluate a flag value

Inject `BridgeFlagsService` and call `flag(key, defaultValue, context?)`. It's
synchronous — the value comes from the in-memory rule cache, so there's no
`await` and no network round-trip:

```typescript
import { Injectable } from '@nestjs/common';
import { BridgeFlagsService } from '@nebulr-group/bridge-nestjs/flags';

@Injectable()
export class PricingService {
  constructor(private readonly flags: BridgeFlagsService) {}

  calculateTotal(cart: CartItem[], userId: string): number {
    // Route to one implementation or the other — no routing involved.
    const useV2 = this.flags.flag('pricing_engine_v2', false, { identity: userId });
    return useV2 ? this.calculateTotalV2(cart) : this.calculateTotalV1(cart);
  }
}
```

| Argument | Description |
|----------|-------------|
| `key` | The flag key, as configured in Control Center |
| `defaultValue` | Safe fallback; also sets the flag's inferred type `T` |
| `context?` | `Partial<EvalContext>` — per-eval `identity` and `attributes` |

`T` is inferred from `defaultValue`. The default is mandatory — it's what you
get when the flag isn't configured or Bridge is unreachable, so a flag call can
never break your service.

## Tune a value without a deploy

A flag doesn't have to be a boolean. Store a number an admin can raise or lower
in Control Center, and read it where you enforce the limit:

```typescript
canUploadMore(currentCount: number, tenantId: string): boolean {
  const maxUploads = this.flags.flag('max_uploads', 10, { identity: tenantId });
  return currentCount < maxUploads;
}
```

An admin ramping `pricing_engine_v2` from 10% to 100%, or raising `max_uploads`
from 10 to 25, takes effect immediately (in `channel` mode, live over the push
channel) — with no code change and no redeploy on your side.

## Pass identity so rollouts resolve

The `context` argument is where you hand the evaluator an `identity`. This
matters whenever the flag has a **percentage rollout**: the SDK buckets the
identity with a stable hash, so the same user (or tenant) always lands in the
same bucket and stays in as you ramp. Without an identity, a rolled-out rule
returns the safe default rather than randomizing per call. For system-level
flags with no rollout you can omit it:

```typescript
// Bucketed per user
this.flags.flag('new_checkout', false, { identity: req.user.id });

// Sticky per tenant (webhooks, queues)
this.flags.flag('new_pipeline', false, { identity: tenantId });

// System-level flag, no rollout, no identity needed
this.flags.flag('worker_v2_enabled', false);
```

See [Send context from your backend](/feature-flags/targeting/send-context/) for
the full identity and attributes story.

## Multi-type values

One API for boolean, string, number, and JSON flags — the type is inferred from
the default:

```typescript
const isDark    = this.flags.flag('dark_mode', false);                     // boolean
const mode      = this.flags.flag('pipeline_mode', 'stable');              // string
const limit     = this.flags.flag('max_uploads', 10);                      // number
const rateLimit = this.flags.flag('rate_limit', { window: 60, max: 100 }); // JSON
```

A type mismatch (admin stored a different type than your default suggests)
returns the default and logs a warning.
