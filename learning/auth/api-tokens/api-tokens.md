---
title: API tokens
description: How BridgeAuthGuard verifies API tokens (x-api-key), what claims you get, and how privilege enforcement differs from user JWTs.
sidebar:
  label: NestJS
---

# API tokens

Bridge lets end users of your app self-service-create API tokens for programmatic access — a CI pipeline, a personal script, a third-party integration — without you building token issuance, storage, or revocation yourself. Creating and managing tokens is self-service UI territory (a drop-in component on the frontend); **bridge-nestjs's job is the other end** — verifying a token when it shows up on a request and exposing its claims to your guards.

## How a token reaches your app

Tokens are sent as `x-api-key`, evaluated as an independent path from the `Authorization: Bearer` (user JWT) path — see [Route guards](/auth/securing/route-guards/) for where this sits in the overall guard flow. Two ways `BridgeAuthGuard` ends up with a verified token on `request.bridgeApiToken`:

1. **Pre-processed** — if something upstream (Bridge's own `bridge-api` gateway, in front of first-party services) already verified the key and set `request.bridgeApiToken`, the guard trusts it as-is and does not re-verify.
2. **Standalone verification** — otherwise, if the `x-api-key` value is JWT-shaped (three non-empty, dot-separated segments), the guard verifies it itself via a JWKS client that's cached independently from the user-JWT one (see [Logging in and logging out](/auth/user-token/logging-in-and-out/) for the shared JWKS-caching model). This is the path a customer NestJS app not sitting behind `bridge-api` uses.
3. **Anything else falls through silently** — a non-JWT-shaped `x-api-key` (an opaque, legacy-style key) produces no `bridgeApiToken` context at all. The guard doesn't error on it; it just behaves as if that header weren't there, and the request has to succeed some other way (a valid `Authorization: Bearer`) or it's rejected for having no credential at all.

## What's on a verified token

```typescript
interface ApiTokenClaims {
  sub: string;
  appId: string;
  tenantId: string | null;
  type: 'api';
  privileges: string[];
}
```

- **`privileges`** — the exact set the token was created with; it can never do more than this list allows. This is the same privilege-key vocabulary your [roles](/auth/roles/how-it-works/) use (`USER_READ`, `TENANT_WRITE`, or a custom key).
- **`tenantId`** — `null` for an app-level token not tied to a specific workspace; a real ID for a workspace-scoped token. See [Multi-tenancy](/auth/multi-tenancy/multi-tenancy/) for what that means for your endpoints.
- **`type: 'api'`** — verified explicitly; a token missing this or carrying the wrong value fails with `TOKEN_INVALID` even if its signature checks out (guards against a user-JWT-shaped token being replayed on the API-token path).
- **`appId`** must match your app's configured `appId` exactly, or verification fails with `APP_MISMATCH` — a token minted for a different Bridge app is rejected outright, even with a valid signature.

Read it directly when `@RequirePrivilege()` isn't enough on its own:

```typescript
import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';

@Controller('reports')
export class ReportsController {
  @Get()
  list(@Req() req: Request) {
    const privileges = req.bridgeApiToken?.privileges ?? [];
    // ...
  }
}
```

## Privilege enforcement is API-token-only

`@RequirePrivilege(privilege)` checks **only** `req.bridgeApiToken.privileges` — it has no effect on a user-JWT-only request; user JWTs bypass it entirely (existing backward-compatibility behavior). This is the single most important thing to get right about this decorator, and it's the flip side of `@RequireRole()`, which checks only the user JWT's role and is a no-op for API-token-only requests. See [How roles & privileges work](/auth/roles/how-it-works/) for the full comparison table.

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, RequirePrivilege } from '@nebulr-group/bridge-nestjs';

@Controller('users')
@UseGuards(BridgeAuthGuard)
export class UsersController {
  @Get()
  @RequirePrivilege('USER_READ')
  listUsers() { /* … */ }
}
```

An empty `privileges: []` array on a token still passes the guard's *authentication* step (it's a validly-signed, correctly-typed, correctly-scoped token) — it's `@RequirePrivilege()` specifically that then rejects it with a `403`.

## Restricting which credential type an endpoint accepts

`@AcceptAuth('jwt' | 'api_token' | 'both')` restricts a route to one credential type; `'both'` (the default) accepts either:

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, AcceptAuth } from '@nebulr-group/bridge-nestjs';

@Controller('account/api-token/me')
@AcceptAuth('jwt') // this endpoint only makes sense for a signed-in person
@UseGuards(BridgeAuthGuard)
export class ApiTokenUserController { /* … */ }
```

When a caller sends **both** headers at once (first-party Bridge frontends like cloud-views always do), both are verified independently and both contexts end up on the request (`bridgeApiToken` *and* `bridgeUser`/`bridgeTenant`/`bridgeAccessToken` all coexisting) — `@AcceptAuth('jwt')` only rejects a request when the API token is the *only* credential offered, not when it's present alongside a valid JWT.

## A note on revocation

Bridge's self-service token UI describes revocation as immediate — a caller presenting a revoked token gets a `401` on its next request. That guarantee is enforced by whichever system is checking the token against Bridge's own token store. Reading `JwksService.verifyApiToken()` directly: **standalone verification only checks the signature, the `type: 'api'` claim, and the `appId` match** — it does not call back to Bridge per request to ask whether this specific token has since been revoked. If your app verifies API tokens standalone (no `bridge-api` middleware in front already populating `request.bridgeApiToken` for you), factor that into your threat model for a compromised token's blast radius, the same caveat that applies to user JWTs (see [Logging in and logging out](/auth/user-token/logging-in-and-out/)).

## Worked example

```typescript
import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, RequirePrivilege } from '@nebulr-group/bridge-nestjs';

@Controller('api-token-test')
class ApiTokenTestController {
  @Get('protected')
  @UseGuards(BridgeAuthGuard)
  protected() {
    return { ok: true };
  }

  @Get('privileged')
  @UseGuards(BridgeAuthGuard)
  @RequirePrivilege('USER_READ')
  privileged() {
    return { ok: true };
  }
}
```

- `x-api-key: <token with USER_READ>` → `GET /api-token-test/privileged` → `200`
- `x-api-key: <token without USER_READ>` → `403`
- `x-api-key: <token with an appId for a different app>` → `401`
- `Authorization: Bearer <user JWT, no privileges claim at all>` → `GET /api-token-test/privileged` → `200` (user JWTs bypass `@RequirePrivilege`)
