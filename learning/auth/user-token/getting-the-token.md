---
title: Getting the user token
description: Reading the authenticated user, tenant, and raw token off a request in a NestJS backend.
sidebar:
  label: NestJS
---

# Getting the user token

There's no store to read and no token to fetch yourself. `BridgeAuthGuard` verifies the incoming `Authorization: Bearer` header (or `x-api-key`) on every request and decodes it onto the request object before your handler runs; see [Route guards](/auth/securing/route-guards/) for when that happens in the request lifecycle.

## The recommended path: `@CurrentUser()` and `@CurrentTenant()`

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, CurrentUser, CurrentTenant, BridgeUser, BridgeTenant } from '@nebulr-group/bridge-nestjs';

@Controller('items')
@UseGuards(BridgeAuthGuard)
export class ItemsController {
  @Get()
  findAll(@CurrentUser() user: BridgeUser, @CurrentTenant() tenant: BridgeTenant) {
    return { requestedBy: user.email, tenant: tenant?.name };
  }
}
```

Both are plain Nest param decorators. They work identically in HTTP controllers and GraphQL resolvers, pulling off `request.bridgeUser` / `request.bridgeTenant` under the hood (`getRequestFromContext` handles the HTTP-vs-GraphQL branching for you). They only ever return a value on a **user JWT** request; an API-token-only request has neither, since API tokens don't carry a user or workspace identity the same way (see [API tokens](/auth/api-tokens/)).

`BridgeUser` is populated straight off the verified JWT claims. There's no separate "minimal identity" vs. "full profile" split the way a frontend often has (one lean reactive object plus a richer profile fetch); this one object already carries everything decoded from the token:

| Field | Type | Description |
|-------|------|--------------|
| `id` | `string` | User ID (`sub` claim) |
| `email` | `string` | Email address |
| `emailVerified` | `boolean` | Email verification status |
| `username` | `string` | Username (`preferred_username`, falls back to email) |
| `fullName` | `string` | Full display name |
| `givenName` / `familyName` | `string \| undefined` | First / last name |
| `locale` | `string \| undefined` | User's locale |
| `onboarded` | `boolean \| undefined` | Whether onboarding is complete |
| `tenantId` | `string` | The workspace (tenant) this token was issued for |
| `appId` | `string \| undefined` | App ID the token was issued for (`aid` claim) |
| `scope` | `string \| undefined` | OAuth scopes on the token |
| `role` | `string \| undefined` | User's role in this workspace |
| `multiTenantAccess` | `boolean \| undefined` | Whether the user can access more than one workspace |
| `privileges` | `string[] \| undefined` | Privilege keys from the JWT `privileges` claim |

`BridgeTenant` is similarly decoded from the token's tenant claims (`tid`/`tenant_id`, `tenant_name`, `tenant_locale`, `tenant_logo`, `tenant_onboarded`). If the token carries no tenant claim, `transformJwtToBridgeTenant` returns `null` and `request.bridgeTenant` (and `@CurrentTenant()`) is `undefined`.

## Reading it off the raw request

`@CurrentUser()`/`@CurrentTenant()` cover the common case. For anything else the guard attaches, read the request directly:

```typescript
import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';

@Controller('debug')
export class DebugController {
  @Get('whoami')
  whoami(@Req() req: Request) {
    return {
      user: req.bridgeUser,
      tenant: req.bridgeTenant,
      apiToken: req.bridgeApiToken, // set on the API-token path instead; see API tokens
    };
  }
}
```

## The raw access token: `request.bridgeAccessToken`

You almost never need this either. But when your handler needs to call another Bridge-aware backend on the caller's behalf (a downstream NestJS service, or Bridge's own management API), forward the verified token instead of re-deriving credentials:

```typescript
import { Controller, Get, Req } from '@nestjs/common';
import { BridgeHttpService } from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';

@Controller('items')
export class ItemsController {
  constructor(private readonly bridgeHttpService: BridgeHttpService) {}

  @Get('from-service-b')
  async getFromServiceB(@Req() req: Request) {
    return this.bridgeHttpService.get('http://service-b/items', req.bridgeAccessToken);
  }
}
```

`request.bridgeAccessToken` is only set on the user-JWT path (it's the exact bearer token the guard just verified). This is the backend counterpart to a frontend `tokenStore`, except there's no refreshing to think about: your handler only ever sees a token that has already been validated for *this* request, and you're not responsible for its lifetime.

## Workspace data beyond the JWT: `BridgeService`

`@CurrentTenant()` only gives you what's baked into the JWT (id, name, locale, logo, onboarded). For subscription plan, entitlements, or branding of the user's workspace (called a *tenant* in the API), use the injectable `BridgeService`, which fetches (and short-TTL-caches) a fuller snapshot for the token's tenant:

```typescript
import { Controller, Get, Headers } from '@nestjs/common';
import { BridgeService } from '@nebulr-group/bridge-nestjs';

@Controller('billing')
export class BillingController {
  constructor(private readonly bridge: BridgeService) {}

  @Get('plan')
  async getPlan(@Headers('authorization') auth: string) {
    const tenant = this.bridge.fromJwt(auth.replace('Bearer ', ''));
    return tenant.subscription;
  }
}
```

See [How the token is kept current](/auth/user-token/object-updates/) for how fresh this snapshot is relative to the JWT-decoded fields, and [Multi-tenancy](/auth/multi-tenancy/multi-tenancy/) for how tenant scoping is enforced.
