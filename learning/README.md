# Bridge NestJS Documentation

Documentation for The Bridge NestJS plugin: authentication, flag-gated access, API token support, feature flags, plan limits and multi-tenancy for NestJS applications.

## The one rule for app code

**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains "USER_WRITE"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.

Two things are not gates and are not flags: **numbers** are plan limits (`<QuotaGate>` in the browser, `@RequireQuota` on the backend), and **permission on one specific record** stays in app code ("only the author edits their post").

Before calling the work done, run `npx @nebulr-group/bridge-cli check gates` in the project. It lists every direct role, privilege, plan or plan-feature check with the flag to use instead. Fix each one.

In NestJS, an endpoint is `@RequireFeatureFlag('…')` on the handler (or a route rule with `featureFlag`).

## Quick links

- [Quickstart guide](./quickstart/quickstart.md): install, configure, and protect routes in minutes
- [Examples](./examples/examples.md): comprehensive examples for all features
- [Authentication and access control](./auth/auth.md)
- [Configuration](./configuration/configuration.md)
- [Feature flags](./feature-flags/feature-flags.md)
- [Plan limits and entitlements](./plan-limits/plan-limits.md): one decorator per handler; counter vs gauge
- [Tenant data via `BridgeService`](./bridge-service/bridge-service.md): subscription, entitlements, and branding for the current request
- [Multi-tenancy](./multi-tenancy/multi-tenancy.md)
- [Frontend integration](./frontend-integration/frontend-integration.md)
- [Error handling](./error-handling/error-handling.md)

## Features

- Built on `@nebulr-group/bridge-auth-core`: JWT/API-token verification delegated to the shared core
- JWT authentication with JWKS verification
- API token authentication (`x-api-key` header) with privilege enforcement
- Route rules: `ANONYMOUS` / `AUTHENTICATED`, plus a `featureFlag` for who gets the route
- API-token scopes via `@RequirePrivilege()` (API tokens only)
- Feature flags, two ways: live-updating (`@RequireFlag` / `@Flag` via `BridgeFlags`) or on-demand over the Bridge API (`@RequireFeatureFlag`)
- Tenant data: `bridge.fromJwt(jwt)` reads subscription, entitlements, and branding for the current request
- GraphQL operation matching in route rules
- Token forwarding between microservices
- Multi-tenancy support with tenant/user extraction
- RFC 6750-compliant error responses
