---
title: How the user token is kept current
description: Why role/privilege changes don't reach an in-flight token, and what does refresh on every request.
sidebar:
  label: NestJS
---

# How the user token is kept current

`BridgeAuthGuard` re-verifies the bearer token on **every single request**; there's no cached "this user is signed in" state sitting between requests the way a session cookie would give you. In that sense, a NestJS backend is always working from fresh information. But "fresh" here means something narrower than it might sound: the guard re-verifies the token's *signature and expiry* on every call, not the *claims inside it* against some source of truth. Whatever role, privileges, and workspace info were baked into the JWT at the moment it was issued are exactly what the guard reads back out: every time, unchanged, until that token expires.

## What this means when a role changes

If an admin changes a user's role in Control Center (your admin dashboard at app.thebridge.dev) right now, and that user's browser is still holding an access token issued five minutes ago, every request from that browser keeps hitting your API with the *old* role for as long as that token remains valid. `BridgeAuthGuard` never queries a roles database to double check; see [How roles & privileges work](/auth/roles/how-it-works/). The change takes effect the moment a *new* token is issued for that user, which in practice means the next silent token refresh a frontend Bridge SDK performs before the old one expires, or their next full sign-in.

This is the one place backend and frontend genuinely diverge, and it's worth being explicit about, because the frontend behavior can be misleading if you're used to it: bridge-svelte's live channel (a persistent realtime connection the SDK maintains) actively pushes a fresh session down to the client and updates its reactive stores the moment something changes server-side, with no user-visible delay. **bridge-nestjs has no equivalent push mechanism for the user JWT.** There is no live channel for auth state, no webhook-to-guard wiring, nothing watching for role changes on your behalf. (The one live channel bridge-nestjs *does* maintain is in the feature-flags module, and it only carries flag rule changes; see [Feature Flags](/feature-flags/feature-flags/).) It's a pure verify-per-request model: correctness is bounded by the token's own TTL, not by how quickly Bridge can tell your backend something changed.

If a role/privilege change needs to take effect immediately rather than on next refresh, that's not something this guard gives you. The options are keeping access-token TTLs short enough that the staleness window is acceptable, or having your own endpoint force a client-side refresh after a change you know just happened.

## The one thing that *is* pulled fresh: `BridgeService`

Workspace-level data that isn't part of the JWT at all (subscription plan, entitlements, branding) goes through a different path: `BridgeService.fromJwt(jwt)` returns a `TenantScope` that fetches (and caches) a session snapshot via `GET /session/init`, independent of what's encoded in the JWT itself.

```typescript
const tenant = this.bridge.fromJwt(userJwt);
const canExport = await tenant.entitlements.can('export');
```

This is fresher than the JWT's baked-in claims, but it's still **pull, not push**: it's backed by a small in-process cache (`BridgePullCache`, 30-second TTL) rather than re-fetching on every call. Concurrent requests for the same user share one in-flight fetch, and the whole snapshot (subscription, entitlements, branding, and a `role`/`tenantId` user snapshot) is replaced atomically on each refresh; there's no half-updated state. If you've just performed a mutation you know changed something in this snapshot (e.g. your own endpoint upgraded the workspace's plan), call `tenant.invalidate()` to force the next read to refetch rather than waiting out the TTL.

Don't treat this snapshot as instantaneous either, though: a 30-second-old entitlement is still a plausible read immediately after a change. The module wires the cache TTL at 30 seconds (it isn't a `BridgeConfig` option), so for anything where that window genuinely matters, invalidate explicitly right after the mutation that should be visible immediately.

## Practical takeaway

- `@CurrentUser()` / `@CurrentTenant()` (JWT-derived): accurate as of *token issuance*, not as of *this request*.
- `BridgeService.fromJwt(jwt)` snapshot slices: accurate as of the last cache refresh (at most 30 seconds old), refetched independently of the JWT.
- Neither is push-live the way a frontend reactive store is. If your app needs to react the instant something changes server-side, that reaction has to live on the frontend (or via Bridge webhooks; see [Multi-tenancy](/auth/multi-tenancy/multi-tenancy/)), not inside this guard.
