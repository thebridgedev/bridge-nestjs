# Get started

Flags come with the SDK you already have: register `BridgeFlagsModule` once
and it wires everything up for you (the rule cache, live updates, and
telemetry). From then on you inject `BridgeFlagsService` anywhere. There is no
separate flags client to create and no flag-specific init call.

## 1. Set up the SDK

`BridgeFlagsModule` lives on the auth-free entry point
`@nebulr-group/bridge-nestjs/flags`, so a standalone-flags app doesn't pull in
the auth guard or the Bridge HTTP client. Add it to your root module with your
Bridge API base URL and a workspace API key:

```typescript
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

`apiBaseUrl` and `apiKey` are the only required options: flags work
standalone, no other Bridge module needed. The module is `@Global()`, so you
register it once and inject `BridgeFlagsService` from any other module without
re-importing.

> **Tip:** The `apiKey` is a JWT-shaped workspace API key. Keep it out of
> source; load it from the environment (or `ConfigModule`) as shown.

### When the key comes from ConfigModule

Use `forRootAsync` to resolve options asynchronously, for example to read the
API key through `ConfigService`:

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BridgeFlagsModule } from '@nebulr-group/bridge-nestjs/flags';

@Module({
  imports: [
    BridgeFlagsModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        apiBaseUrl: config.getOrThrow('BRIDGE_API_BASE_URL'),
        apiKey: config.getOrThrow('BRIDGE_API_KEY'),
      }),
    }),
  ],
})
export class AppModule {}
```

## 2. Create a flag in Control Center

In Control Center (your admin dashboard at app.thebridge.dev), open Feature
Flags and create a boolean flag, for example `use_new_pipeline`, and leave it
off.

## 3. Read the flag in a service

Inject `BridgeFlagsService` and call `flag(key, defaultValue, context?)`.
Evaluation is synchronous and local, so there's no `await`:

```typescript
import { Injectable } from '@nestjs/common';
import { BridgeFlagsService } from '@nebulr-group/bridge-nestjs/flags';

@Injectable()
export class ReportsService {
  constructor(private readonly flags: BridgeFlagsService) {}

  generate(userId: string) {
    if (this.flags.flag('use_new_pipeline', false, { identity: userId })) {
      return this.generateV2();
    }
    return this.generateV1();
  }
}
```

The second argument is the default: the value your app uses when the flag
isn't configured or Bridge is unreachable, so a flag check can never break
your service. The third argument is the eval context; passing an `identity`
is what lets percentage rollouts bucket the caller.

## 4. Flip it and watch it change live

With your service running, go back to Control Center and turn
`use_new_pipeline` on. The new pipeline takes over without a restart,
typically within seconds: rule changes arrive over the live channel (a
persistent realtime connection the SDK maintains) and the next `flag()` call
reads the updated rule. Flip it off again and traffic returns to the old path
the same way.

That's the whole loop: create a flag, read it in code with a safe default,
and control it from Control Center from then on.

## Pick a runtime mode

The default `runtimeMode: 'channel'` holds a live WebSocket connection and is
the right choice for an always-on API. For an ephemeral runtime that can't
keep a socket open (a cron job, a serverless function, a webhook handler), set
`runtimeMode: 'pull'` to skip the socket and poll a short-lived REST cache
instead. See [How flags work](/feature-flags/how-it-works/) for the
difference.

## Next steps

- [Use flags in your logic](/feature-flags/using/in-logic/) to branch a service or handler on a flag value
- [Guard routes](/feature-flags/using/guard-routes/) to reject a request before the handler runs
- [Send context from your backend](/feature-flags/targeting/send-context/) so rollouts and targeting resolve
