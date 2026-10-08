<p align="center">
  <a href="https://thebridge.dev/?utm_source=github&utm_medium=readme&utm_campaign=bridge-nestjs"><img src="https://raw.githubusercontent.com/thebridgedev/bridge-nestjs/main/.github/assets/banner.png" alt="The Bridge for NestJS" width="100%"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nebulr-group/bridge-nestjs"><img src="https://img.shields.io/npm/v/@nebulr-group/bridge-nestjs?color=20006b&label=npm" alt="npm version"></a>
  <a href="https://github.com/thebridgedev/bridge-nestjs/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@nebulr-group/bridge-nestjs?color=20006b" alt="MIT license"></a>
</p>

<p align="center">
  <a href="https://thebridge.dev/?utm_source=github&utm_medium=readme&utm_campaign=bridge-nestjs"><b>Website</b></a> ·
  <a href="https://thebridge.dev/docs/quickstart/nestjs/?utm_source=github&utm_medium=readme&utm_campaign=bridge-nestjs"><b>Quickstart</b></a> ·
  <a href="https://thebridge.dev/docs/?utm_source=github&utm_medium=readme&utm_campaign=bridge-nestjs"><b>Docs</b></a> ·
  <a href="https://thebridge.dev/docs/ai-assistants/mcp/?utm_source=github&utm_medium=readme&utm_campaign=bridge-nestjs"><b>Set up with your AI assistant</b></a>
</p>

# The Bridge for NestJS

`@nebulr-group/bridge-nestjs` protects a NestJS API with Bridge: token verification, flag-gated endpoints, plan limits and tenant data, as a module, a guard and decorators.

**[The Bridge](https://thebridge.dev/?utm_source=github&utm_medium=readme&utm_campaign=bridge-nestjs)** is a hosted backend for SaaS apps. It gives you sign-in (passwords, magic links, passkeys, social login and SSO), multi-tenant workspaces with roles, Stripe subscriptions with plan limits, and feature flags, all managed from one dashboard. Your AI coding assistant can set it up for you through the [Bridge MCP server](https://thebridge.dev/docs/ai-assistants/mcp/?utm_source=github&utm_medium=readme&utm_campaign=bridge-nestjs).

## The one rule for app code

**Every gate in app code is a flag.** A link, a page, a button, an endpoint: if some people get it and others do not, the code asks a flag, and the flag's rule says why: a privilege (`privileges contains "USER_WRITE"`), a plan feature (`bridge:billing.entitlement.analytics eq true`) or a rollout. App code never reads a role, a privilege list, the plan or a plan feature to decide what someone may see or do.

Two things are not gates and are not flags: **numbers** are plan limits (`<QuotaGate>` in the browser, `@RequireQuota` on the backend), and **permission on one specific record** stays in app code ("only the author edits their post").

Before calling the work done, run `npx @nebulr-group/bridge-cli check gates` in the project. It lists every direct role, privilege, plan or plan-feature check with the flag to use instead. Fix each one.

In NestJS, an endpoint is `@RequireFeatureFlag('…')` on the handler (or a route rule with `featureFlag`).

## Structure

```
bridge-nestjs/
├── bridge-nestjs/    # The publishable @nebulr-group/bridge-nestjs library
├── demo/             # Demo NestJS application
├── docker-compose.yml
└── Dockerfile
```

## Development

### Using Docker (recommended)

```bash
# Start the development container
docker-compose up -d

# Enter the container
docker exec -it bridge-nestjs zsh

# Inside container: install dependencies
npm install

# Build the library
npm run build

# Start the demo app
npm run start:demo
```

### Local Development

```bash
# Install dependencies
npm install

# Build the library
npm run build

# Start the demo app
npm run start:demo
```

## Demo App

The demo app runs on `http://localhost:3000` and demonstrates:

- Global guard with route rules
- Public routes (`/health`)
- Protected routes (`/items`)
- Flag-gated admin area (`/admin/*`, `@RequireFeatureFlag('admin-area')` ruled on a privilege)
- Feature flag gating (`/beta/*`)
- Decorator usage for fine-grained control

### Environment Variables

```bash
BRIDGE_APP_ID=your-app-id
BRIDGE_DEBUG=true
```

## Publishing

```bash
# Build and pack the library
npm run package

# This creates @nebulr-group/bridge-nestjs-x.x.x.tgz in the root
```

## Documentation

See [bridge-nestjs/README.md](./bridge-nestjs/README.md) for the full API and [`learning/`](learning/README.md) for the guides.

## Learn more

- [Quickstart](https://thebridge.dev/docs/quickstart/nestjs/?utm_source=github&utm_medium=readme&utm_campaign=bridge-nestjs)
- [Authentication](https://thebridge.dev/docs/auth/nestjs/?utm_source=github&utm_medium=readme&utm_campaign=bridge-nestjs)
- [Feature flags](https://thebridge.dev/docs/feature-flags/nestjs/?utm_source=github&utm_medium=readme&utm_campaign=bridge-nestjs)
- [Plan limits](https://thebridge.dev/docs/plan-limits/nestjs/?utm_source=github&utm_medium=readme&utm_campaign=bridge-nestjs)
- [Tenant data](https://thebridge.dev/docs/bridge-service/nestjs/?utm_source=github&utm_medium=readme&utm_campaign=bridge-nestjs)
- [Multi-tenancy](https://thebridge.dev/docs/multi-tenancy/nestjs/?utm_source=github&utm_medium=readme&utm_campaign=bridge-nestjs)
- [Error handling](https://thebridge.dev/docs/error-handling/nestjs/?utm_source=github&utm_medium=readme&utm_campaign=bridge-nestjs)
- [Examples](https://thebridge.dev/docs/examples/nestjs/?utm_source=github&utm_medium=readme&utm_campaign=bridge-nestjs)

## Other Bridge packages

| Package | For |
|---|---|
| [`@nebulr-group/bridge-svelte`](https://www.npmjs.com/package/@nebulr-group/bridge-svelte) | SvelteKit |
| [`@nebulr-group/bridge-react`](https://www.npmjs.com/package/@nebulr-group/bridge-react) | React |
| [`@nebulr-group/bridge-nextjs`](https://www.npmjs.com/package/@nebulr-group/bridge-nextjs) | Next.js |
| [`@nebulr-group/bridge-angular`](https://www.npmjs.com/package/@nebulr-group/bridge-angular) | Angular |
| [`@nebulr-group/bridge-express`](https://www.npmjs.com/package/@nebulr-group/bridge-express) | Express |
| [`@nebulr-group/bridge-cli`](https://www.npmjs.com/package/@nebulr-group/bridge-cli) | CLI for people and AI agents |
| [`@nebulr-group/bridge-auth-core`](https://www.npmjs.com/package/@nebulr-group/bridge-auth-core) | Any JavaScript app (core) |

## License

[MIT](https://github.com/thebridgedev/bridge-nestjs/blob/main/LICENSE) © Nebulr. Built by [The Bridge](https://thebridge.dev/?utm_source=github&utm_medium=readme&utm_campaign=bridge-nestjs).
