# Bridge NestJS

This workspace contains the Bridge NestJS plugin and a demo application.

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
- Role-based access (`/admin/*`)
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
