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
6. **Route-rule privilege** (anything beyond `ANONYMOUS`/`AUTHENTICATED`): enforced against the user JWT's privileges, when a user JWT is present.
7. **`@RequireRole()`**: enforced against the user JWT's role.
8. **`@RequireFeatureFlag()`**: enforced by evaluating the flag against the user's access token.

Role, privilege-decorator, and feature-flag checks only run once a credential of the relevant type has been verified; see [Roles & Privileges](/auth/roles/how-it-works/) and [API tokens](/auth/api-tokens/) for exactly which credential each check applies to.

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
      { path: '/users/*', privilege: 'USER_READ' },
      { path: '/account/subscription/*', privilege: 'TENANT_WRITE' },
      { graphqlOperation: 'listUsers', privilege: 'USER_READ' },
      { graphqlOperation: 'deleteUser', privilege: 'USER_WRITE' },
    ],
  },
})
```

| Rule field | Type | Description |
|---|---|---|
| `path` | `string` | REST URL wildcard pattern, e.g. `/account/subscription/**`. Matched against the request path only (not method). |
| `graphqlOperation` | `string` | GraphQL operation name, case-sensitive camelCase, e.g. `listUsers`. |
| `privilege` | `RoutePrivilege` (required) | `'ANONYMOUS'`, `'AUTHENTICATED'`, one of the built-in privilege strings, or any custom string that must appear in the user JWT's `privileges` claim. |
| `plans` | `string[]` | Present on the type for a future plan-restriction feature. **Not currently enforced by `BridgeAuthGuard`**; don't rely on it to gate access yet. |

Rules are matched in order; the first match wins. GraphQL requests are matched only against `graphqlOperation` rules, REST requests only against `path` rules; provide the field that applies.

**Roles and feature flags are not part of route rules.** They're decorator-only (`@RequireRole()`, `@RequireFeatureFlag()`). Route rules cover privilege-gating and public/anonymous access; see [Configuration](/auth/config/) for the full `RouteRule` / `GuardConfig` reference.
