# Target anonymous visitors

On the frontend, the Bridge SDK manages an anonymous identity for you: it
mints a stable anonymous ID on first load and persists it, so a visitor
buckets consistently into a rollout before they ever sign in. A backend has no
such ambient identity. A NestJS process handles requests for many callers, so
there's nothing to persist and no "current visitor" to fall back on.

That means: **on the backend, a request with no verified user is evaluated
anonymously.** The guard, `@Flag` and `req.bridgeFlagsContext` carry no
identity for it, so a flag with a targeting rule or a percentage rollout
returns its default.

The SDK does not read an identity from the `x-bridge-context` header a
browser may send: that header is internal and client-controlled, and trusting
it would let any caller evaluate as any user (TBP-671). See
[Per-request context](/feature-flags/using/backend/).

## Supply a stable identity yourself

For a request with no signed-in user (an anonymous visitor, a webhook, a
server-to-server call, a job), pass whatever stable string the evaluation
should be sticky on, from something your server controls. It
doesn't have to be a user id; a workspace id, a session id, or any durable key
works, as long as the *same* subject always yields the *same* string:

```typescript
this.flags.flag('new_pipeline', false, { identity: tenantId });
```

What you must not do is invent a fresh random identity per call to satisfy a
rollout: that would put the same subject in a different bucket every request.
If you genuinely have no stable identity and the flag has a percentage
rollout, the SDK returns the safe default with a warning rather than
randomizing; that's the correct, sticky-by-omission behavior. For system-level
flags with no rollout, no identity is needed at all.
