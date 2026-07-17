---
title: Multi-tenancy
description: How BridgeAuthGuard derives and scopes a request to exactly one tenant, and what that guarantees (and doesn't).
sidebar:
  label: NestJS
---

# Multi-tenancy

Bridge is multi-tenant: a person can belong to more than one **workspace** (called a *tenant* in the API), with a role, plan, and permissions that are configured separately per workspace. The same person can be `ADMIN` in one workspace and `OWNER` in another. From your NestJS backend's side, though, there's no concept of "the user's workspaces" (plural) to reason about at request time. There's only ever the **one workspace a given request's token was minted for**.

## Where the workspace comes from, on a request

`BridgeAuthGuard` derives the workspace purely from the verified JWT's `tid` (or `tenant_id`) claim, never from anything the caller sends in a URL param, header, or request body. `transformJwtToBridgeTenant()` reads that claim and populates `request.bridgeTenant` (and hence `@CurrentTenant()`); if the token carries no tenant claim at all, both are `undefined`.

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, CurrentUser, CurrentTenant, BridgeUser, BridgeTenant } from '@nebulr-group/bridge-nestjs';

@Controller('items')
@UseGuards(BridgeAuthGuard)
export class ItemsController {
  @Get()
  findAll(@CurrentUser() user: BridgeUser, @CurrentTenant() tenant: BridgeTenant) {
    // user.tenantId and tenant.id are the same value: the tenant this
    // specific token was issued for, and nothing else.
    return { tenantId: user.tenantId };
  }
}
```

There's no server-side "which workspace is currently active" state the way a frontend keeps one; a NestJS process is stateless and handles requests for many different workspaces concurrently. Each request is scoped independently by whatever its own token says.

## What the guard does (and doesn't) isolate

The guard authenticates the request and tells you which workspace the token belongs to. **It does not scope your database queries for you.** Isolation is enforced by your app code always filtering by the verified `tenantId`, never by anything the client supplies:

```typescript
@Controller('items')
export class ItemsController {
  @Post()
  async create(@Body() data: CreateItemDto, @CurrentUser() user: BridgeUser) {
    // tenantId comes from the verified token, not from the request body,
    // so a client can't create data in a tenant it doesn't hold a token for.
    return this.itemsService.create(data, user.tenantId, user.id);
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentUser() user: BridgeUser) {
    const item = await this.itemsService.findOne(id, user.tenantId);
    if (!item) throw new NotFoundException('Item not found');
    return item;
  }
}
```

Given that, a token minted for workspace A cannot be used to read or write workspace B's data through an endpoint built this way. Not because the guard blocks it, but because there's no code path that would ever look up workspace B using workspace A's token. The failure mode to watch for is the opposite: an endpoint that reads a `tenantId` from `@Body()`/`@Param()`/a header instead of `@CurrentUser().tenantId` reopens exactly this hole. See [Multi-tenancy patterns](/multi-tenancy/multi-tenancy/) for concrete data-separation strategies (column-based, schema-based, JIT/webhook provisioning) that build on this.

## Role is per-workspace too

`user.role` reflects that person's role **in this workspace**; it's the same JWT claim that's tenant-scoped. If the same person holds `OWNER` in one workspace and `MEMBER` in another, `@RequireRole()` checks in your endpoints are automatically correct per-request without any extra tenant-awareness on your part, because the role in the token was already resolved for the workspace the token was issued against. See [How roles & privileges work](/auth/roles/how-it-works/).

## API tokens and workspace scope

`ApiTokenClaims.tenantId` is `string | null`: a token created for a specific workspace carries that workspace's ID; an app-level token (not tied to any one workspace) has `tenantId: null`. **Don't assume every authenticated request has a workspace.** Check for it explicitly if your endpoint accepts both user JWTs and API tokens (see [API tokens](/auth/api-tokens/)), since `request.bridgeApiToken?.tenantId` can legitimately be `null` even on an otherwise-valid request.

## No "switching workspace" on the backend

Bridge's frontend SDKs let a user switch their active workspace, which re-issues a session scoped to the new workspace. There's no equivalent operation in bridge-nestjs; from this side, "switching workspaces" is invisible. It's just the next request arriving with a token that happens to have a different `tid` claim than the last one. Nothing to wire up, and nothing to invalidate on your end when it happens.

## Fresher workspace data than the JWT

`@CurrentTenant()` only exposes what's in the token (id, name, locale, logo, onboarded). For subscription/entitlement/branding data scoped to the same workspace, `BridgeService.fromJwt(jwt)` pulls a fuller, independently-cached snapshot; see [How the token is kept current](/auth/user-token/object-updates/) for exactly how fresh that is.
