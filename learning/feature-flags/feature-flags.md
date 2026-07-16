---
title: Feature Flags
order: 40
oneLiner: Ship behind a flag and change who sees what, live from Control Center, no redeploy.
related: [auth, payments]
---

# Feature Flags

Bridge Feature Flags lets you ship code dark, roll it out gradually, target it
at specific users, and kill it instantly, all without a deploy. The SDK
evaluates flags locally: it keeps your flag rules in memory, evaluates them
against in-process context, and receives rule changes over the live channel (a
persistent realtime connection the SDK maintains). A flag check is a
synchronous O(1) lookup with no network call and no `await`, safe in hot
request paths.

Flags work standalone: an `apiBaseUrl` and an `apiKey` are all the
configuration you need. `BridgeFlagsModule` is auth-free and requires no other
Bridge module; Bridge auth and billing are optional context sources you can
target on once they're wired in.

## The mental model

1. **You create a flag in Control Center** (your admin dashboard at
   app.thebridge.dev) and give it rules: on/off, a percentage rollout, or
   conditions on attributes like `user.role` or `tenant.plan`.
2. **The SDK evaluates those rules locally** against the eval context: the
   identity and attributes a flag rule evaluates against. On a backend your
   code supplies both; an attribute provider can feed verified auth claims in
   once you register it.
3. **Changes arrive live.** Edit a rule in Control Center and every connected
   service updates in place, typically within seconds, over the live channel.
   No restart, no redeploy.

For the full picture (evaluation model, runtime modes, outage behavior), read
[How flags work](/feature-flags/how-it-works/).

## Get started

[Get started](/feature-flags/get-started/) walks the whole loop in a few
minutes: register `BridgeFlagsModule`, create a flag in Control Center, read
it with `BridgeFlagsService.flag()`, then flip it and watch your service
change live.

## Using flags

- [Use flags in your logic](/feature-flags/using/in-logic/): the
  `BridgeFlagsService.flag()` API for branching code paths, plus multi-type
  values (boolean, string, number, JSON).
- [Guard routes](/feature-flags/using/guard-routes/): gate whole endpoints
  behind a flag with `BridgeFlagGuard` + `@RequireFlag`; a request is rejected
  before your handler ever runs.
- [Receiving forwarded context](/feature-flags/using/backend/): read the eval
  context a Bridge frontend forwards in the `x-bridge-context` header so your
  server and the browser agree on identity and bucketing.

## Targeting

- [Target by plan or role](/feature-flags/targeting/by-plan-or-role/): register
  an attribute provider once and attributes like `user.role` and `tenant.plan`
  merge into every evaluation from your verified JWT claims. For plan-granted
  features, prefer entitlement attributes; see
  [Lock features to a plan](/billing/limits/lock-features/).
- [Send context from your backend](/feature-flags/targeting/send-context/):
  supply an `identity` for bucketing and app-specific facts (like a project
  count) per call, per request via the interceptor, or module-wide via
  `initialContext`.
- [Target anonymous visitors](/feature-flags/targeting/anonymous/): reuse the
  anonymous ID a Bridge frontend forwards, or supply your own stable identity,
  so percentage rollouts bucket the same visitor the same way on both sides.

> **Framework note:** The main `@nebulr-group/bridge-nestjs` entry point also
> ships an on-demand path (`@RequireFeatureFlag` / `FeatureFlagService`) that
> evaluates boolean flags over the Bridge API, keyed on the caller's access
> token, with a 5-minute per-token cache. Reach for it when you just need a
> quick boolean check and don't want to run a flags client; see
> [Gate features by role or privilege](/auth/roles/gate-with-flags/) for how
> the two mechanisms compare.
