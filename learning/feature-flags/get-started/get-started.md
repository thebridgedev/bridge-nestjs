# Get started

Register the flags module once, then inject `BridgeFlagsService` anywhere.

## Install and register the module

`BridgeFlagsModule` lives on the auth-free entry point `@nebulr-group/bridge-nestjs/flags`, so a standalone-flags app doesn't pull in the auth guard or the Bridge HTTP client. Add it to your root module with your Bridge API base URL and a workspace API key:

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

`apiBaseUrl` and `apiKey` are the only required options — flags work standalone, no other Bridge module needed. The module is `@Global()`, so you register it once and inject `BridgeFlagsService` from any other module without re-importing.

> **Tip:** The `apiKey` is a JWT-shaped workspace API key. Keep it out of source — load it from the environment (or `ConfigModule`) as shown.

## When the key comes from ConfigModule

Use `forRootAsync` to resolve options asynchronously — for example, to read the API key through `ConfigService`:

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

## Evaluate your first flag

Inject `BridgeFlagsService` and call `flag(key, defaultValue, context?)`. Evaluation is synchronous and local — no `await`:

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

The default (`false` above) is mandatory — it's what you get when the flag isn't configured in Control Center or Bridge is unreachable, so a flag check can never break your service.

## Pick a runtime mode

The default `runtimeMode: 'channel'` holds a live WebSocket connection and is the right choice for an always-on API. For an ephemeral runtime that can't keep a socket open — a cron job, a serverless function, a webhook handler — set `runtimeMode: 'pull'` to skip the socket and poll a short-lived REST cache instead. See [How flags work](/feature-flags/how-it-works/) for the difference.

## Next steps

- [Use flags in your logic](/feature-flags/using/in-logic/) — branch a service or handler on a flag value.
- [Guard routes](/feature-flags/using/guard-routes/) — reject a request before the handler runs.
- [Send context from your backend](/feature-flags/targeting/send-context/) — supply identity and attributes so rollouts and targeting resolve.
