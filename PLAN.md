# Bridge NestJS Plugin – Working Plan

## Goals
- Provide an easy-to-adopt NestJS plugin for Bridge with bearer-token auth.
- Align defaults with existing frontend plugins (appId, authBaseUrl, backendlessBaseUrl, debug).
- Deliver a global guard/decorator experience similar to other Bridge plugins.

## Scope (initial)
1) **Auth Guard (Bearer only)**
   - Accept `Authorization: Bearer <accessToken>`.
   - Validate JWT via JWKS from `authBaseUrl`; check exp/nbf/iss/aud.
   - Populate request user/context; on failure return `401 { error: 'unauthorized', message: 'Access token missing or invalid' }`.
2) **Feature Flags**
   - Service to call backendless API (bulk evaluate with 5m cache; single evaluate when forced).
   - Decorator/guard to require a flag (or set) before route execution.
3) **Config**
   - Config service/module with defaults (authBaseUrl, backendlessBaseUrl, teamManagementUrl, loginRoute, defaultRedirectRoute, debug).
   - Support env-driven config; require `appId`.
4) **Developer Experience**
   - Module exports: `BridgeModule`, `BridgeAuthGuard`, `RequireFeatureFlag` decorator.
   - Clear README/usage examples for REST; note bearer-only for now.
5) **Non-goals (for later)**
   - API keys support.
   - Cookie-based auth/refresh handling.
   - Team management handover endpoints.

## Open Questions / Assumptions
- 401 payload can include a dev-friendly hint; no redirects in default flow.
- For SSR/Next-style setups, we will revisit optional cookie support later.
