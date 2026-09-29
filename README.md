# Bridge NestJS

This workspace contains the Bridge NestJS plugin and a demo application.

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

See [bridge-nestjs/README.md](./bridge-nestjs/README.md) for full API documentation.
