# Receiving forwarded context

Evaluating a flag in NestJS is local and instant. But when a Bridge frontend
(Svelte, React, Angular, Next.js) also evaluates the *same* flag for the
*same* user, both sides have to agree on identity; otherwise a percentage
rollout can put the browser in the "on" bucket and your API in the "off"
bucket for one request, a split-brain. The frontend knows the visitor's
identity and whatever attributes it set; your NestJS service has no way to
know either unless the frontend sends them.

The frontend SDKs serialize their eval context into an `x-bridge-context`
header on requests to your API. This page is about receiving it.

## Wire up BridgeContextInterceptor

Register `BridgeContextInterceptor` as an app-level interceptor. It reads the
`x-bridge-context` header off each request, deserializes it, and stashes the
resulting `{ identity, attributes }` on `req.bridgeFlagsContext`:

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

Once it's in place, the guard (`@RequireFlag`), the `@Flag` param decorator,
and any per-request eval you do all pick up `req.bridgeFlagsContext`
automatically; they bucket against the same identity the frontend just used.
A missing or malformed header is a no-op: the request still works, it just
falls back to the module's global context.

## Evaluate with the forwarded context

The interceptor merges the forwarded identity with anything an upstream auth
guard already put on `req.bridgeUser` / `req.user`. Read the resolved context
off the request and pass it straight into `flag()`:

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

Because the identity matches what the browser evaluated against, the browser
and your API land in the same rollout bucket for that user.

## What to trust, and what not to

Only accept forwarded identity and attributes the backend genuinely can't
derive itself: an anonymous visitor ID, a cart size held in client state, a
locale picked in the UI. **Never trust a forwarded `role`- or `plan`-style
attribute**: the browser could set any value. Read those from your own
verified sources (the user's JWT, your own record of the workspace, which the
API calls a *tenant*) by registering an `AuthAttributeProvider`, so plan/role
targeting resolves from claims you verified rather than values the wire
handed you. See
[Target by plan or role](/feature-flags/targeting/by-plan-or-role/).
