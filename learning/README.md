# Bridge NestJS Documentation

Documentation for The Bridge NestJS plugin — authentication, privilege-based access control, API token support, feature flags, and multi-tenancy for NestJS applications.

## Quick Links

- [Quickstart Guide](./quickstart/quickstart.md) — Install, configure, and protect routes in minutes
- [Examples](./examples/examples.md) — Comprehensive examples for all features
- [Authentication & Access Control](./auth/auth.md)
- [Configuration](./configuration/configuration.md)
- [Feature Flags](./feature-flags/feature-flags.md)
- [Tenant Data — `BridgeService`](./bridge-service/bridge-service.md) — subscription, entitlements, branding for the current request
- [Multi-Tenancy](./multi-tenancy/multi-tenancy.md)
- [Frontend Integration](./frontend-integration/frontend-integration.md)
- [Error Handling](./error-handling/error-handling.md)

## Features

- Built on `@nebulr-group/bridge-auth-core` — JWT/API-token verification delegated to the shared core
- JWT authentication with JWKS verification
- API token authentication (`x-api-key` header) with privilege enforcement
- Privilege-based route rules (`ANONYMOUS`, `AUTHENTICATED`, `USER_READ`, etc.)
- Role-based access control via `@RequireRole()` decorator
- Feature flags — two approaches: live-updating (`@RequireFlag` / `@Flag` via `BridgeFlags`) or on-demand over the Bridge API (`@RequireFeatureFlag`)
- Tenant data — `bridge.fromJwt(jwt)` reads subscription, entitlements, and branding for the current request
- GraphQL operation matching in route rules
- Plan-gated routes (subscription-based access)
- Token forwarding between microservices
- Multi-tenancy support with tenant/user extraction
- RFC 6750-compliant error responses
