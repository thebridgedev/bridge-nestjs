# Bridge NestJS Documentation

Documentation for The Bridge NestJS plugin — authentication, privilege-based access control, API token support, feature flags, and multi-tenancy for NestJS applications.

## Quick Links

- [Quickstart Guide](./quickstart/quickstart.md) — Install, configure, and protect routes in minutes
- [Examples](./examples/examples.md) — Comprehensive examples for all features

## Features

- JWT authentication with JWKS verification
- API token authentication (`x-api-key` header) with privilege enforcement
- Privilege-based route rules (`ANONYMOUS`, `AUTHENTICATED`, `USER_READ`, etc.)
- Role-based access control via `@RequireRole()` decorator
- Feature flags via `@RequireFeatureFlag()` decorator
- GraphQL operation matching in route rules
- Plan-gated routes (subscription-based access)
- Token forwarding between microservices
- Multi-tenancy support with tenant/user extraction
- RFC 6750-compliant error responses
