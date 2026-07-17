---
title: Logging in and logging out
description: Why bridge-nestjs has no login/logout of its own, and what it does instead, verifying a token on every request.
sidebar:
  label: NestJS
---

# Logging in and logging out

`@nebulr-group/bridge-nestjs` doesn't have a login or logout flow, and it isn't meant to. Signing in happens in a frontend Bridge SDK (or the CLI, or directly against `bridge-api`), which is what actually calls the authentication endpoints and ends up holding a JWT. Your NestJS app is a **resource server**: it never issues tokens, never stores a session, and never needs to know whether "login" or "logout" happened. All it does is verify whatever token shows up on the next request.

That reframes the interesting question for a backend package: not "how does a user sign in," but "what makes a request trustworthy," on every single call. That's `BridgeAuthGuard` and `JwksService`.

## What happens on every request

1. **The guard runs on every matching request**, global or per-route (see [Route guards](/auth/securing/route-guards/)); there's no server-side session or "already authenticated" flag it can shortcut past. Each request re-verifies its own bearer token from scratch.
2. **Verification is signature + issuer + audience + expiry**, via `jose`'s `jwtVerify` against Bridge's JWKS endpoint. `JwksService.verifyToken()` checks the token was signed by a known Bridge key, issued by `{apiBaseUrl}/auth`, and scoped to your `appId`.
3. **The JWKS keyset itself is cached, not fetched per request**: one hour TTL, refreshed lazily the first time it's needed after expiry. This local-JWKS model applies to **user JWTs only**; API tokens are verified by a different mechanism entirely (introspection, a POST to the Bridge per uncached request; see [API tokens](/auth/api-tokens/)).
4. **No revocation list is consulted for user JWTs.** The guard's JWKS verification only checks the four things above; it does not call back to `bridge-api` per request to ask "has this specific token been revoked." A user JWT remains acceptable to the guard for as long as it's unexpired and correctly signed, full stop. (API tokens are the opposite: introspection re-checks the backing record, so their revocation is effectively immediate by default.)

That last point is the practical answer to "logging out": from bridge-nestjs's point of view, logout is a non-event. There's no server-side session for a logout to invalidate, because there was never a server-side session to begin with; a frontend `logout()` call just erases the token from `localStorage` on the client. If the same (still-unexpired) access token were replayed against your API after that, the guard would still accept it; it has no way to know the frontend "logged out." This is exactly why Bridge's own frontend SDKs proactively refresh short-lived access tokens rather than relying on long-lived ones, and why revocable, hash-at-rest API tokens exist as a separate mechanism for the cases that need immediate invalidation. See [API tokens](/auth/api-tokens/).

## Failure modes you'll actually see

Since there's no "sign back in" step on this side either, every rejection is really "this token, right now, doesn't verify", surfaced as RFC 6750-style errors so a client can react appropriately instead of just seeing a bare `401`:

| `TokenVerificationError` code | `WWW-Authenticate` `error` | Typical cause |
|---|---|---|
| *(no header at all)* | `missing_token` | No `Authorization` header sent |
| `TOKEN_EXPIRED` | `expired_token` | Token's `exp` has passed; client should refresh and retry |
| `TOKEN_INVALID` | `invalid_token` | Malformed token, or (API-token path) introspection reported the token inactive (forged, revoked, expired) or not an API token |
| `JWKS_NO_MATCH` | `invalid_token` | Signed by a key not in the current JWKS; often a stale local JWKS cache pointed at the wrong environment |
| `CLAIM_VALIDATION_FAILED` | `invalid_token` | Issuer/audience mismatch |
| `APP_MISMATCH` | `invalid_token` | (API-token path only) token's `appId` doesn't match this app |

A well-behaved client distinguishes `expired_token` (silently refresh, then retry) from everything else (send the user back through the actual sign-in flow, which lives entirely outside this package).

## If you're building your own admin/session endpoints

If your NestJS app proxies to Bridge's own management API for things like role changes, that's still not "login"; it's your backend forwarding an already-verified caller's token (`req.bridgeAccessToken`) to Bridge. See [Assign roles to users](/auth/roles/assign-roles/) for a worked example of that pattern.
