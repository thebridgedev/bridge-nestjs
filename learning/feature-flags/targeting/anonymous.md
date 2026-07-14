# Target anonymous visitors

On the frontend, the Bridge SDK manages an anonymous identity for you — it mints
a stable anonymous ID on first load and persists it, so a visitor buckets
consistently into a rollout before they ever sign in. A backend has no such
ambient identity. A NestJS process handles requests for many callers, so there's
nothing to persist and no "current visitor" to fall back on.

That means: **on the backend, anonymous bucketing only works if the caller
brings an identity.** There are two ways it gets there.

## Use a forwarded anonymous ID

When the request comes from a Bridge frontend, the anonymous ID the browser
already generated rides along in the `x-bridge-context` header.
`BridgeContextInterceptor` deserializes it onto `req.bridgeFlagsContext`, and the
guard, `@Flag`, and any per-request eval reuse it — so the browser and your API
bucket the same pre-login visitor into the same rollout. This is the common case,
and it needs no anonymous-specific code beyond wiring the interceptor. See
[Receiving forwarded context](/feature-flags/using/backend/).

## Supply a stable identity yourself

For a request with no forwarded context — a webhook, a server-to-server call, a
job — pass whatever stable string the evaluation should be sticky on. It doesn't
have to be a user id; a tenant id, a session id, or any durable key works, as
long as the *same* subject always yields the *same* string:

```typescript
this.flags.flag('new_pipeline', false, { identity: tenantId });
```

What you must not do is invent a fresh random identity per call to satisfy a
rollout — that would put the same subject in a different bucket every request. If
you genuinely have no stable identity and the flag has a percentage rollout, the
SDK returns the safe default with a warning rather than randomizing; that's the
correct, sticky-by-omission behavior. For system-level flags with no rollout, no
identity is needed at all.
