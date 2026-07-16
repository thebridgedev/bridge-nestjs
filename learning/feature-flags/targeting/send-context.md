# Send context from your backend

Every flag check runs against an eval context: the identity and attributes a
flag rule evaluates against. On a backend, none of that data is ambient. A
server process isn't "a user," so the evaluator starts every call knowing
nothing about who it's for. You supply the context: an `identity` for
bucketing, and `attributes` for the app-specific facts your targeting rules
depend on.

## The eval context

Every `flag()` call takes an optional `context: Partial<EvalContext>`:

```typescript
interface EvalContext {
  identity?: string;                    // stable per-eval identity, for bucketing
  attributes: Record<string, unknown>;  // flat or nested attribute map
}
```

## Identity: required for rollouts

`identity` is the stable string the SDK hashes to pick a rollout bucket. Pass
the id of whoever the evaluation is *on behalf of*: usually the requesting
user, sometimes the workspace (called a *tenant* in the API) for background
work:

```typescript
// On behalf of the requesting user
this.flags.flag('feature_x', false, { identity: req.user.id });

// Sticky per-workspace behavior (webhooks, queues, cron)
this.flags.flag('new_pipeline', false, { identity: tenantId });
```

The same identity always lands in the same bucket, so a user who's in the
first 10% stays in as you ramp to 25%, 50%, 100%. No flicker, nobody gets
re-rolled. **A percentage rollout requires identity**: if a rollout rule is
active and you pass none, the SDK returns the safe default with a warning
rather than randomizing per call. For a system-level flag with no rollout, you
can omit it entirely.

## Attributes: target on facts only your app knows

Send your own attributes when the thing you want to target on is a business
fact that lives in your own data, not in Bridge. For example: "only enable the
new dashboard for workspaces with more than 3 projects." Bridge has no idea
how many projects a workspace has, so you tell it:

```typescript
this.flags.flag('new_dashboard', false, {
  identity: tenantId,
  attributes: { project_count: projectCount },
});
```

With `project_count` flowing in, an admin can add a rule in Control Center
(your admin dashboard at app.thebridge.dev) such as
`project_count greater than 3` without you touching this code again. That's
the pattern: send whatever app-specific fact the targeting decision depends
on, once, and every future rule change is a Control Center edit, not a
redeploy.

## Per-request context via the interceptor

Threading `context` through every call by hand gets tedious. When a Bridge
frontend forwards its context on the `x-bridge-context` header,
`BridgeContextInterceptor` deserializes it once per request and puts it on
`req.bridgeFlagsContext`, which the guard and `@Flag` decorator read
automatically, so you don't pass it manually on gated routes. See
[Receiving forwarded context](/feature-flags/using/backend/).

## A global context on the module

For attributes that apply to the whole process (a deployment region, an
environment name), set an `initialContext` on the module once, and every eval
that doesn't override the key inherits it:

```typescript
BridgeFlagsModule.forRoot({
  apiBaseUrl: 'https://api.thebridge.dev',
  apiKey: process.env.BRIDGE_API_KEY!,
  initialContext: { attributes: { region: 'eu' } },
});
```

You can also replace it at runtime with `flags.setContext(ctx, merge?)`.

## Verified attributes are different

Do not send `role`/`plan`-style attributes as raw per-call attributes on a
backend: those come from a verified source, not from whatever a caller handed
you. Register an `AuthAttributeProvider` instead, which reads your decoded JWT
claims on every eval. See
[Target by plan or role](/feature-flags/targeting/by-plan-or-role/).
