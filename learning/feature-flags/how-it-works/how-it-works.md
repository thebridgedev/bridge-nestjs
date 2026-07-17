# How flags work

A feature flag is a switch on a piece of behavior in your app that you control
from Control Center (your admin dashboard at app.thebridge.dev) instead of from
a deploy. Wrap something in a flag and you can:

- **Ship dark**: merge and deploy a feature while it's still off for everyone,
  then turn it on when it's ready.
- **Roll out gradually**: turn it on for 10% of users, watch, then ramp to
  25%, 50%, 100%.
- **Target a segment** (an audience defined by attribute rules): turn it on
  only for a role, a plan, an internal group, or any attribute your app sends.
- **Kill it instantly**: something's wrong in production? Flip the flag off and
  it works as a kill switch. No rollback, no redeploy.

Every one of those is an action you take in Control Center. Flip a flag there
and it reaches every connected service live, typically within seconds. No
restart, no redeploy. That's possible because of how flags evaluate:

Bridge Feature Flags **evaluates locally**. The SDK keeps your flag rules in
memory, evaluates them against in-process context, and receives rule changes
over the live channel (a persistent realtime connection the SDK maintains). A
flag check is a synchronous O(1) lookup with no network call and no `await`,
so it's safe to call directly in a hot request path.

## The evaluation model

- **No network on read.** `BridgeFlagsService.flag()`, `@RequireFlag`, and
  `@Flag` evaluate against an in-memory rule cache; there's no request per
  flag check.
- **Live rule updates** arrive over the live channel as `flag.updated` /
  `flag.removed` messages and update the rule cache in place. So flipping a
  flag, ramping a rollout, or hitting a kill switch is a Control Center
  action; your deployed code never changes.
- **Telemetry** (which flags evaluated to what) is batched and reported in the
  background, off the request path.

## It stays up through outages

When the live channel drops, flags **freeze on their last-known values** and
refetch on reconnect, so your service keeps working through Bridge outages. A
flag check never throws and never blocks a request; the worst case is a stale
value or, for an unconfigured flag, your default.

## Runtime modes

`BridgeFlagsModule.forRoot` takes a `runtimeMode`:

- **`'channel'` (default)**: a long-running NestJS service holds a live
  WebSocket connection to Bridge and receives rule changes as they happen.
  This is what you want for a normal always-on API.
- **`'pull'`**: for ephemeral runtimes that can't hold a socket (cron jobs,
  serverless functions, webhook handlers, CLI scripts). The RealtimeClient is
  skipped entirely; reads still evaluate locally, but the rule set refreshes
  by polling a TTL-bounded REST cache (`BridgePullCache`, default TTL 30 s)
  instead of receiving push updates. Inject the cache via
  `@Inject(BRIDGE_PULL_CACHE)`.

```typescript
BridgeFlagsModule.forRoot({
  apiBaseUrl: 'https://api.thebridge.dev',
  apiKey: process.env.BRIDGE_API_KEY!,
  runtimeMode: 'pull', // ephemeral runtime, no live socket
});
```

## Backend evaluation semantics

The Nest module runs in **backend mode** by default. A server process isn't "a
user," so the evaluator never invents an identity, and, critically, it refuses
to bucket a rolled-out rule without an explicit identity. If a percentage
rollout is active and you don't pass an `identity`, the SDK returns the safe
default with a warning rather than randomizing per call (which would make the
same user flip-flop request to request). Pass identity per eval; see
[Send context from your backend](/feature-flags/targeting/send-context/).

## Flags work standalone

`BridgeFlagsModule` is auth-free: an `apiBaseUrl` and `apiKey` are all the
configuration flags need, no other Bridge module required. When Bridge auth or
billing *is* in your app, you can surface their state as targeting attributes
by registering an attribute provider (see
[Target by plan or role](/feature-flags/targeting/by-plan-or-role/)).

Next: [Get started](/feature-flags/get-started/).
