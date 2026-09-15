# Per-request context

Evaluating a flag in NestJS is local and instant. For a flag with a
percentage rollout or a targeting rule, the evaluation needs to know *who* the
request is for. On the backend that answer comes from one place only: the
caller your server verified.

## Wire up BridgeContextInterceptor

Register `BridgeContextInterceptor` as an app-level interceptor. On each
request it puts the verified caller's identity on `req.bridgeFlagsContext`
(and the flags instance on `req.bridgeFlags`, which `@Flag` needs):

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { BridgeFlagsModule, BridgeContextInterceptor } from '@nebulr-group/bridge-nestjs/flags';

@Module({
  imports: [
    BridgeFlagsModule.forRoot({
      apiBaseUrl: 'https://api.thebridge.dev',
      apiKey: process.env.BRIDGE_API_KEY!,
    }),
  ],
  providers: [{ provide: APP_INTERCEPTOR, useClass: BridgeContextInterceptor }],
})
export class AppModule {}
```

The identity is `req.bridgeUser.id` (set by `BridgeAuthGuard` from a
signature-checked token), falling back to `req.user.id` (set by your own
server-side auth). With neither, the request is evaluated anonymously:
`req.bridgeFlagsContext` is `undefined`, and a flag with a rule or a rollout
returns its default. The guard (`@RequireFlag`) and the `@Flag` param
decorator evaluate for the same verified caller on their own, so they work
whether or not the interceptor is registered.

## Evaluate with the per-request context

Read the context off the request and pass it straight into `flag()`:

```typescript
import { Controller, Post, Req } from '@nestjs/common';
import { BridgeFlagsService } from '@nebulr-group/bridge-nestjs/flags';

@Controller('checkout')
export class CheckoutController {
  constructor(private readonly flags: BridgeFlagsService) {}

  @Post()
  create(@Req() req) {
    const useV2 = this.flags.flag('pricing_engine_v2', false, req.bridgeFlagsContext);
    return useV2 ? this.createV2(req.body) : this.createV1(req.body);
  }
}
```

Because the Bridge frontends evaluate with the same user id, the browser and
your API land in the same rollout bucket for a signed-in user.

## The x-bridge-context header is not trusted

Bridge frontends can send an `x-bridge-context` header. It is internal, and
**this SDK never reads identity or attributes from it**. Any client can send
that header with any content: before 0.7.0-beta.1, a request carrying
somebody else's user id and `tenant.plan: enterprise` was evaluated as that
user on that plan (TBP-671). If you proxy requests from a frontend to NestJS,
you don't need to forward it, and nothing on the backend should read it.

Targeting attributes such as `user.role` and `tenant.plan` come from your own
verified sources (the user's JWT, your own record of the workspace, which the
API calls a *tenant*) through an attribute provider. See
[Target by plan or role](/feature-flags/targeting/by-plan-or-role/).
App-specific facts your server knows (a project count, a region) go in
per-call `attributes`; see
[Send context from your backend](/feature-flags/targeting/send-context/).

## Route guards are not authorization

Flags decide which code path runs. Protect data with `BridgeAuthGuard`, roles
and privileges, and your own checks.
