# Bridge NestJS Documentation

Documentation for The Bridge NestJS plugin: authentication, privilege-based access control, API token support, feature flags, and multi-tenancy for NestJS applications.

## Quick links

- [Quickstart guide](./quickstart/quickstart.md): install, configure, and protect routes in minutes
- [Examples](./examples/examples.md): comprehensive examples for all features
- [Authentication and access control](./auth/auth.md)
- [Configuration](./configuration/configuration.md)
- [Feature flags](./feature-flags/feature-flags.md)
- [Tenant data via `BridgeService`](./bridge-service/bridge-service.md): subscription, entitlements, and branding for the current request
- [Multi-tenancy](./multi-tenancy/multi-tenancy.md)
- [Frontend integration](./frontend-integration/frontend-integration.md)
- [Error handling](./error-handling/error-handling.md)

## Features

- Built on `@nebulr-group/bridge-auth-core`: JWT/API-token verification delegated to the shared core
- JWT authentication with JWKS verification
- API token authentication (`x-api-key` header) with privilege enforcement
- Privilege-based route rules (`ANONYMOUS`, `AUTHENTICATED`, `USER_READ`, etc.)
- Role-based access control via `@RequireRole()` decorator
- Feature flags, two ways: live-updating (`@RequireFlag` / `@Flag` via `BridgeFlags`) or on-demand over the Bridge API (`@RequireFeatureFlag`)
- Tenant data: `bridge.fromJwt(jwt)` reads subscription, entitlements, and branding for the current request
- GraphQL operation matching in route rules
- Token forwarding between microservices
- Multi-tenancy support with tenant/user extraction
- RFC 6750-compliant error responses
