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

## The one rule for app code

**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains "USER_WRITE"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.

Two things are not gates and are not flags: **numbers** are plan limits (`<QuotaGate>` in the browser, `@RequireQuota` on the backend), and **permission on one specific record** stays in app code ("only the author edits their post").

Before calling the work done, run `npx @nebulr-group/bridge-cli check gates` in the project. It lists every direct role, privilege, plan or plan-feature check with the flag to use instead. Fix each one.

In NestJS, an endpoint is `@RequireFeatureFlag('…')` on the handler (or a route rule with `featureFlag`).

## The mental model

1. **You create a flag in Control Center** (your admin dashboard at
   app.thebridge.dev) and give it rules: on/off, a percentage rollout, or
   conditions such as `privileges contains "USER_WRITE"` or a plan feature
   (`bridge:billing.entitlement.analytics eq true`).
2. **The SDK evaluates those rules locally** against the eval context: the
   identity and attributes a flag rule evaluates against. On a request
   `BridgeAuthGuard` verified, the SDK fills in the user's privileges and the
   plan's features for you, the same as in the browser.
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
- [Per-request context](/feature-flags/using/backend/): how each request is
  evaluated for the verified caller, and why the `x-bridge-context` header a
  client sends is never trusted.

## Targeting

- [Target by plan feature or privilege](/feature-flags/targeting/by-plan-or-role/):
  rules on `privileges` or a plan feature (`bridge:billing.entitlement.<feature>`)
  work with no wiring. For a feature a plan sells, list it on the plans and
  point the rule at the plan's feature; see
  [Lock features to a plan](/billing/limits/lock-features/).
- [Send context from your backend](/feature-flags/targeting/send-context/):
  supply an `identity` for bucketing and app-specific facts (like a project
  count) per call, per request via the interceptor, or module-wide via
  `initialContext`.
- [Target anonymous visitors](/feature-flags/targeting/anonymous/): supply
  your own stable identity for callers who aren't signed in, so percentage
  rollouts bucket them consistently.

> **Framework note:** The main `@nebulr-group/bridge-nestjs` entry point also
> ships an on-demand path (`@RequireFeatureFlag` / `FeatureFlagService`) that
> evaluates boolean flags over the Bridge API, keyed on the caller's access
> token, with a 5-minute per-token cache. It is the simplest way to put a flag
> on an endpoint and needs no flags client; see
> [Gate features with flags](/auth/roles/gate-with-flags/) for how the two
> mechanisms compare.
