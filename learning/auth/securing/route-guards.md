---
title: Route guards
description: Global vs per-controller vs per-route protection with BridgeAuthGuard, plus centralized route rules.
sidebar:
  label: NestJS
---

# Route guards

`BridgeAuthGuard` is a standard Nest `CanActivate` guard. It works against both HTTP controllers and GraphQL resolvers; for GraphQL it reads the request off the resolver context and matches rules against the operation name instead of a URL path.

There are three ways to apply it, and they combine.

## Global guard (recommended)

Register it once via `BridgeModule.forRoot()` and every route is protected unless explicitly excepted:

```typescript
import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';

@Module({
  imports: [
    BridgeModule.forRoot({
      appId: 'YOUR_APP_ID',
      guard: {
        global: true,
        defaultAccess: 'protected',
        rules: [
          { path: '/health', privilege: 'ANONYMOUS' },
          { path: '/webhooks/*', privilege: 'ANONYMOUS' },
        ],
      },
    }),
  ],
})
export class AppModule {}
```

With the global guard enabled, mark specific handlers public with `@Public()`:

```typescript
import { Controller, Get } from '@nestjs/common';
import { Public } from '@nebulr-group/bridge-nestjs';

@Controller()
export class AppController {
  @Get('health')
  @Public()
  healthCheck() {
    return { status: 'ok' };
  }
}
```

`@Public()` always wins; it's checked first and overrides both the global guard and any route rule.

## Per-controller guard

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('items')
@UseGuards(BridgeAuthGuard)
export class ItemsController {
  @Get()
  findAll(@CurrentUser() user: BridgeUser) {
    return { message: 'Protected', user: user.email };
  }
}
```

## Per-route guard

```typescript
@Controller('items')
export class ItemsController {
  @Get()
  findAll() {
    return { message: 'Public endpoint' };
  }

  @Get('private')
  @UseGuards(BridgeAuthGuard)
  findPrivate(@CurrentUser() user: BridgeUser) {
    return { message: 'Protected endpoint', user: user.email };
  }
}
```

## What the guard checks, in order

1. **`@Public()` decorator**: if present, the route is allowed immediately, no matter what else is configured.
2. **Route rule with `privilege: 'ANONYMOUS'`**: same effect as `@Public()`, but centrally configured (see below).
3. **No matching rule + `defaultAccess: 'public'`**: allowed.
4. **Credential verification**: a user JWT on `Authorization: Bearer` is verified locally against Bridge's JWKS keyset; an API token on `x-api-key` is verified by introspection (a POST to the Bridge, which checks the token's signature and backing record). At least one valid credential is required past this point, or the request gets a `401`.
5. **`@RequirePrivilege()`**: enforced against the API token's privileges, when an API token is present.
6. **`@RequireFeatureFlag()`**: enforced by evaluating the flag against the user's access token.
7. **Route-rule `featureFlag`**: the matching rule's flag, evaluated the same way.

`@RequirePrivilege()` is API tokens only; flags gate a signed-in person. Each check runs once a credential of the relevant type has been verified; see [Roles & Privileges](/auth/roles/how-it-works/) and [API tokens](/auth/api-tokens/) for exactly which credential each check applies to.

## Centralized route rules

Instead of decorating every controller, list rules once in `guard.rules`. Each rule matches either a REST path (wildcard `*` supported) or a GraphQL operation name:

```typescript
BridgeModule.forRoot({
  appId: 'YOUR_APP_ID',
  guard: {
    global: true,
    defaultAccess: 'protected',
    rules: [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/api/status', privilege: 'AUTHENTICATED' },
      { path: '/users/*', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
      { path: '/account/subscription/*', privilege: 'AUTHENTICATED', featureFlag: 'manage-billing' },
      { graphqlOperation: 'listUsers', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
      { graphqlOperation: 'deleteUser', privilege: 'AUTHENTICATED', featureFlag: 'manage-users' },
    ],
  },
})
```

| Rule field | Type | Description |
|---|---|---|
| `path` | `string` | REST URL wildcard pattern, e.g. `/account/subscription/**`. Matched against the request path only (not method). |
| `graphqlOperation` | `string` | GraphQL operation name, case-sensitive camelCase, e.g. `listUsers`. |
| `privilege` | `'ANONYMOUS' \| 'AUTHENTICATED'` (required) | Whether the route needs a signed-in caller. |
| `featureFlag` | `string \| { any } \| { all }` | The flag that decides who gets the route; its rule says why (e.g. `privileges contains "USER_WRITE"`). |

Rules are matched in order; the first match wins. GraphQL requests are matched only against `graphqlOperation` rules, REST requests only against `path` rules; provide the field that applies.

**Who gets a route is a flag**, set as `featureFlag` here or `@RequireFeatureFlag()` on the handler. A rule that still carries a privilege key or the removed `plans` / `entitlement` / `role` options stops the app at startup with an error naming the flag setup to use. See [Configuration](/auth/config/) for the full `RouteRule` / `GuardConfig` reference.
