# Bridge NestJS Examples

Here we show the features of The Bridge NestJS plugin. You can also see the features in action in our demo application in this monorepo.

To start the demo app:

```bash
# From the project root
docker exec -it bridge-nestjs zsh

# Install dependencies and build
npm install
npm run build

# Start the demo
npm run start:demo
```

## Table of Contents

- [Token Forwarding Between Services](#token-forwarding-between-services)
- [Error Handling and Token Refresh](#error-handling-and-token-refresh)
- [Frontend Integration](#frontend-integration)
  - [How Authentication Works](#how-authentication-works)
  - [Sending Tokens with Fetch](#sending-tokens-with-fetch)
  - [Sending Tokens with Axios](#sending-tokens-with-axios)
  - [Using Bridge Svelte](#using-bridge-svelte)
  - [Using Bridge React](#using-bridge-react)
- [Authentication](#authentication)
  - [Accessing User Information](#accessing-user-information)
  - [Accessing Tenant Information](#accessing-tenant-information)
  - [Per-Route vs Global Protection](#per-route-vs-global-protection)
- [Role-Based Access Control](#role-based-access-control)
  - [Role Requirements via Config](#role-requirements-via-config)
  - [Role Requirements via Decorator](#role-requirements-via-decorator)
  - [Overriding Config with Decorators](#overriding-config-with-decorators)
- [Feature Flags](#feature-flags)
  - [Feature Flag via Config](#feature-flag-via-config)
  - [Feature Flag via Decorator](#feature-flag-via-decorator)
  - [Any vs All Requirements](#any-vs-all-requirements)
  - [Programmatic Feature Flag Checks](#programmatic-feature-flag-checks)
- [Multi-Tenancy Patterns](#multi-tenancy-patterns)
  - [Data Separation Strategies](#data-separation-strategies)
  - [Just-in-Time Provisioning](#just-in-time-jit-provisioning)
  - [Webhook-Based Provisioning](#webhook-based-provisioning)
  - [Recommended Pattern: Webhooks + JIT Fallback](#recommended-pattern-webhooks--jit-fallback)
  - [Scoping Queries by Tenant](#scoping-queries-by-tenant)
- [Configuration](#configuration)
  - [Basic Configuration](#basic-configuration)
  - [Async Configuration](#async-configuration)
  - [Environment Variables](#environment-variables)
  - [Route Rules Reference](#route-rules-reference)

## Token Forwarding Between Services

When your NestJS app needs to call another internal service on behalf of the authenticated user,
use `BridgeHttpService` to forward the user's token. This ensures the downstream service can
also verify the user's identity and permissions.

### Basic Token Forwarding

```typescript
// src/orders/orders.controller.ts
import { Controller, Get, Req } from '@nestjs/common';
import { BridgeHttpService } from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';

@Controller('orders')
export class OrdersController {
  constructor(private readonly bridgeHttpService: BridgeHttpService) {}

  @Get()
  async getOrders(@Req() req: Request) {
    // The user's verified token is forwarded to inventory-service
    return this.bridgeHttpService.get(
      'http://inventory-service/items',
      req.bridgeAccessToken,
    );
  }

  @Post()
  async createOrder(@Body() dto: CreateOrderDto, @Req() req: Request) {
    return this.bridgeHttpService.post(
      'http://order-service/orders',
      dto,
      req.bridgeAccessToken,
    );
  }
}
```

### Calling Public Downstream Endpoints

If the downstream endpoint is public (no auth required), pass `undefined` as the token:

```typescript
@Get('catalog')
async getCatalog() {
  // No token → no Authorization header sent
  return this.bridgeHttpService.get('http://catalog-service/products');
}
```

### Handling Downstream Errors

`BridgeHttpService` throws `BridgeHttpError` on non-2xx responses:

```typescript
import { BridgeHttpService, BridgeHttpError } from '@nebulr-group/bridge-nestjs';

@Get('inventory')
async getInventory(@Req() req: Request) {
  try {
    return await this.bridgeHttpService.get(
      'http://inventory-service/stock',
      req.bridgeAccessToken,
    );
  } catch (error) {
    if (error instanceof BridgeHttpError) {
      if (error.status === 404) {
        return { stock: [] };
      }
      throw new InternalServerErrorException('Inventory service unavailable');
    }
    throw error;
  }
}
```

---

## Error Handling and Token Refresh

The `BridgeAuthGuard` returns RFC 6750-compliant `WWW-Authenticate` response headers so your
frontend can distinguish between error types and handle them appropriately.

### Error Codes

| `WWW-Authenticate` error | Meaning | Recommended action |
|---|---|---|
| `missing_token` | No Authorization header was sent | Redirect to login |
| `expired_token` | Token signature is valid but past expiry | Attempt silent refresh, then redirect |
| `invalid_token` | Token is malformed, tampered, or uses an unknown key | Redirect to login |

### Frontend Auto-Refresh Pattern

```typescript
// src/lib/api.ts
import { auth } from '@nebulr-group/bridge-react'; // or bridge-svelte

async function apiFetch(endpoint: string, options: RequestInit = {}) {
  const token = auth.getAccessToken();

  const response = await fetch(`http://localhost:3000${endpoint}`, {
    ...options,
    headers: {
      ...options.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 401) {
    const wwwAuth = response.headers.get('WWW-Authenticate') ?? '';

    if (wwwAuth.includes('expired_token')) {
      // Token expired — try silent refresh
      try {
        await auth.refresh();
        const newToken = auth.getAccessToken();

        // Retry the request once with the new token
        return fetch(`http://localhost:3000${endpoint}`, {
          ...options,
          headers: {
            ...options.headers,
            Authorization: `Bearer ${newToken}`,
            'Content-Type': 'application/json',
          },
        }).then((r) => r.json());
      } catch {
        // Refresh failed — redirect to login
        auth.login();
        return;
      }
    }

    // missing_token or invalid_token — redirect to login
    auth.login();
    return;
  }

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}
```

---

## Frontend Integration

This section explains how your frontend application should send the access token to your NestJS backend.

### How Authentication Works

The Bridge NestJS plugin expects the access token to be sent in the `Authorization` header using the Bearer scheme:

```
Authorization: Bearer <access_token>
```

The flow is:
1. User logs in via Bridge (frontend handles this)
2. Frontend receives and stores the access token
3. Frontend includes the token in API requests to your backend
4. Bridge NestJS validates the token and extracts user/tenant info

### Sending Tokens with Fetch

Using the native `fetch` API:

```typescript
// Get your access token (from your auth state/store)
const accessToken = getAccessToken();

// Make an authenticated request
const response = await fetch('http://localhost:3000/api/items', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  },
});

const data = await response.json();
```

### Sending Tokens with Axios

Create an Axios instance with an interceptor:

```typescript
import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:3000/api',
});

// Add auth interceptor
api.interceptors.request.use((config) => {
  const accessToken = getAccessToken(); // Get from your auth store
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

// Use the configured instance
const response = await api.get('/items');
```

### Using Bridge Svelte

If your frontend uses `@nebulr-group/bridge-svelte`, get the token from the auth service:

```svelte
<script lang="ts">
  import { auth } from '@nebulr-group/bridge-svelte';
  
  async function fetchItems() {
    const tokens = auth.getToken();
    if (!tokens?.accessToken) {
      console.error('Not authenticated');
      return;
    }

    const response = await fetch('http://localhost:3000/api/items', {
      headers: {
        'Authorization': `Bearer ${tokens.accessToken}`,
      },
    });
    
    return response.json();
  }
</script>
```

Or create a reusable API helper:

```typescript
// src/lib/api.ts
import { auth } from '@nebulr-group/bridge-svelte';

export async function apiFetch(endpoint: string, options: RequestInit = {}) {
  const tokens = auth.getToken();
  
  const headers = new Headers(options.headers);
  if (tokens?.accessToken) {
    headers.set('Authorization', `Bearer ${tokens.accessToken}`);
  }
  headers.set('Content-Type', 'application/json');

  const response = await fetch(`http://localhost:3000${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

// Usage
const items = await apiFetch('/api/items');
const newItem = await apiFetch('/api/items', {
  method: 'POST',
  body: JSON.stringify({ name: 'New Item' }),
});
```

### Using Bridge React

If your frontend uses `@nebulr-group/bridge-react`, use the `useBridgeToken` hook:

```tsx
import { useBridgeToken } from '@nebulr-group/bridge-react';

function ItemsList() {
  const { getAccessToken, isAuthenticated } = useBridgeToken();
  const [items, setItems] = useState([]);

  useEffect(() => {
    async function fetchItems() {
      if (!isAuthenticated) return;
      
      const accessToken = getAccessToken();
      const response = await fetch('http://localhost:3000/api/items', {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });
      
      const data = await response.json();
      setItems(data);
    }
    
    fetchItems();
  }, [isAuthenticated, getAccessToken]);

  return (
    <ul>
      {items.map(item => <li key={item.id}>{item.name}</li>)}
    </ul>
  );
}
```

Or create a custom hook for API calls:

```typescript
// src/hooks/useApi.ts
import { useBridgeToken } from '@nebulr-group/bridge-react';
import { useCallback } from 'react';

export function useApi() {
  const { getAccessToken } = useBridgeToken();

  const apiFetch = useCallback(async (endpoint: string, options: RequestInit = {}) => {
    const accessToken = getAccessToken();
    
    const response = await fetch(`http://localhost:3000${endpoint}`, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    return response.json();
  }, [getAccessToken]);

  return { apiFetch };
}

// Usage in component
function MyComponent() {
  const { apiFetch } = useApi();
  
  const handleClick = async () => {
    const data = await apiFetch('/api/items');
    console.log(data);
  };
  
  return <button onClick={handleClick}>Fetch Items</button>;
}
```

## Authentication

### Accessing User Information

Use the `@CurrentUser()` decorator to access the authenticated user:

```typescript
// src/users/users.controller.ts
import { Controller, Get } from '@nestjs/common';
import { CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('users')
export class UsersController {
  @Get('me')
  getProfile(@CurrentUser() user: BridgeUser) {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      fullName: user.fullName,
      tenantId: user.tenantId,
      role: user.role,
      onboarded: user.onboarded,
    };
  }
}
```

The `BridgeUser` interface contains:

```typescript
interface BridgeUser {
  id: string;           // User ID (sub claim)
  email: string;        // User's email
  emailVerified: boolean;
  username: string;     // preferred_username
  fullName: string;     // Display name
  givenName?: string;
  familyName?: string;
  locale?: string;
  onboarded?: boolean;
  tenantId: string;     // Tenant/workspace ID
  role?: string;        // User's role in tenant
  multiTenantAccess?: boolean;
}
```

### Accessing Tenant Information

Use the `@CurrentTenant()` decorator to access tenant details:

```typescript
// src/workspace/workspace.controller.ts
import { Controller, Get } from '@nestjs/common';
import { CurrentUser, CurrentTenant, BridgeUser, BridgeTenant } from '@nebulr-group/bridge-nestjs';

@Controller('workspace')
export class WorkspaceController {
  @Get()
  getWorkspace(
    @CurrentUser() user: BridgeUser,
    @CurrentTenant() tenant: BridgeTenant,
  ) {
    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        locale: tenant.locale,
        onboarded: tenant.onboarded,
      },
    };
  }
}
```

The `BridgeTenant` interface contains:

```typescript
interface BridgeTenant {
  id: string;
  name: string;
  locale?: string;
  logo?: string;
  onboarded?: boolean;
}
```

### Per-Route vs Global Protection

#### Global Guard (Recommended)

Enable the global guard in your module configuration:

```typescript
// src/app.module.ts
BridgeModule.forRoot({
  appId: 'YOUR_APP_ID',
  guard: {
    global: true,
    defaultAccess: 'protected', // All routes protected by default
    rules: [
      { path: '/health', public: true },
      { path: '/webhooks/*', public: true, methods: ['POST'] },
    ],
  },
})
```

With global guard enabled, use `@Public()` to mark exceptions:

```typescript
import { Public } from '@nebulr-group/bridge-nestjs';

@Controller()
export class AppController {
  @Get('health')
  @Public()
  healthCheck() {
    return { status: 'ok' };
  }
}
```

#### Per-Controller Guard

Apply the guard to specific controllers:

```typescript
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('items')
@UseGuards(BridgeAuthGuard)
export class ItemsController {
  @Get()
  findAll(@CurrentUser() user: BridgeUser) {
    return { message: 'Protected', user: user.email };
  }
}
```

#### Per-Route Guard

Apply the guard to specific routes:

```typescript
@Controller('items')
export class ItemsController {
  @Get()
  findAll() {
    return { message: 'Public endpoint' };
  }

  @Get('private')
  @UseGuards(BridgeAuthGuard)
  findPrivate(@CurrentUser() user: BridgeUser) {
    return { message: 'Protected endpoint', user: user.email };
  }
}
```

## Role-Based Access Control

### Role Requirements via Config

Define role requirements in your route rules:

```typescript
// src/app.module.ts
BridgeModule.forRoot({
  appId: 'YOUR_APP_ID',
  guard: {
    global: true,
    rules: [
      { path: '/health', public: true },
      { path: '/admin/*', role: 'ADMIN' },
      { path: '/owner/*', role: 'OWNER' },
    ],
  },
})
```

All routes under `/admin/*` now require the `ADMIN` role.

### Role Requirements via Decorator

Use the `@RequireRole()` decorator for fine-grained control:

```typescript
// src/admin/admin.controller.ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { BridgeAuthGuard, RequireRole, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('admin')
@UseGuards(BridgeAuthGuard)
@RequireRole('ADMIN') // All routes require ADMIN
export class AdminController {
  @Get('dashboard')
  getDashboard(@CurrentUser() user: BridgeUser) {
    return { message: 'Admin dashboard', admin: user.email };
  }

  @Get('users')
  listUsers(@CurrentUser() user: BridgeUser) {
    return { message: 'User list', requestedBy: user.email };
  }
}
```

### Overriding Config with Decorators

Decorators always override config rules. This is useful for exceptions:

```typescript
// src/admin/admin.controller.ts
@Controller('admin')
@UseGuards(BridgeAuthGuard)
export class AdminController {
  // Uses ADMIN role from config rule
  @Get('dashboard')
  getDashboard(@CurrentUser() user: BridgeUser) {
    return { dashboard: 'data' };
  }

  // Override: requires OWNER instead of ADMIN
  @Get('settings')
  @RequireRole('OWNER')
  getSettings(@CurrentUser() user: BridgeUser) {
    return { settings: 'sensitive data' };
  }
}
```

## Feature Flags

### Feature Flag via Config

Define feature flag requirements in route rules:

```typescript
// src/app.module.ts
BridgeModule.forRoot({
  appId: 'YOUR_APP_ID',
  guard: {
    global: true,
    rules: [
      { path: '/health', public: true },
      { path: '/beta/*', featureFlag: 'beta-access' },
      { path: '/premium/*', featureFlag: { all: ['premium-tier', 'active-subscription'] } },
    ],
  },
})
```

### Feature Flag via Decorator

Use the `@RequireFeatureFlag()` decorator:

```typescript
// src/beta/beta.controller.ts
import { Controller, Get } from '@nestjs/common';
import { RequireFeatureFlag, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

@Controller('features')
export class FeaturesController {
  // Single flag requirement
  @Get('new-dashboard')
  @RequireFeatureFlag('beta-dashboard')
  getNewDashboard(@CurrentUser() user: BridgeUser) {
    return { dashboard: 'beta version' };
  }

  // Requires ALL flags
  @Get('premium-reports')
  @RequireFeatureFlag({ all: ['premium-tier', 'reports-v2'] })
  getPremiumReports(@CurrentUser() user: BridgeUser) {
    return { reports: 'premium data' };
  }

  // Requires ANY flag
  @Get('experimental')
  @RequireFeatureFlag({ any: ['beta-tester', 'internal-user'] })
  getExperimental(@CurrentUser() user: BridgeUser) {
    return { feature: 'experimental' };
  }
}
```

### Any vs All Requirements

Feature flags support three modes:

```typescript
// Single flag - must be enabled
{ featureFlag: 'beta-access' }

// ANY - at least one must be enabled
{ featureFlag: { any: ['beta-v1', 'beta-v2', 'internal'] } }

// ALL - every flag must be enabled
{ featureFlag: { all: ['premium', 'kyc-verified', 'active'] } }
```

### Programmatic Feature Flag Checks

Inject `FeatureFlagService` for runtime checks:

```typescript
// src/reports/reports.service.ts
import { Injectable, Req } from '@nestjs/common';
import { FeatureFlagService } from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';

@Injectable()
export class ReportsService {
  constructor(private readonly featureFlags: FeatureFlagService) {}

  async generateReport(accessToken: string) {
    // Check single flag
    const hasPdfExport = await this.featureFlags.isEnabled('pdf-export', accessToken);
    
    // Check with requirement object
    const hasPremium = await this.featureFlags.evaluateRequirement(
      { all: ['premium-tier', 'active-subscription'] },
      accessToken
    );

    if (hasPdfExport) {
      return this.generatePdfReport();
    }
    return this.generateBasicReport();
  }
}
```

In a controller, get the access token from the request:

```typescript
// src/reports/reports.controller.ts
import { Controller, Get, Req } from '@nestjs/common';
import { CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get()
  async getReport(
    @CurrentUser() user: BridgeUser,
    @Req() req: Request,
  ) {
    const accessToken = req.bridgeAccessToken!;
    return this.reportsService.generateReport(accessToken);
  }
}
```

## Multi-Tenancy Patterns

This section covers how to structure your backend to handle multiple tenants (accounts/workspaces) and users, and how to know when new ones are created.

### Data Separation Strategies

There are several ways to separate data per tenant in your backend:

**1. Column-based separation (Recommended for most cases)**

Add a `tenantId` column to your tables and filter by it:

```typescript
// entities/item.entity.ts
@Entity()
export class Item {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;  // Foreign key to tenant

  @Column()
  name: string;

  @Column()
  createdBy: string; // User ID
}
```

**2. Schema-based separation**

Create a separate database schema per tenant (more isolation, more complexity).

**3. Database-based separation**

Completely separate databases per tenant (maximum isolation, highest complexity).

For most applications, **column-based separation** provides the right balance of simplicity and isolation.

### Just-in-Time (JIT) Provisioning

The simplest approach: when you see a new tenant/user ID in a request, create the record automatically.

```typescript
// services/tenants.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant } from '../entities/tenant.entity';

@Injectable()
export class TenantsService {
  constructor(
    @InjectRepository(Tenant)
    private tenantRepo: Repository<Tenant>,
  ) {}

  async ensureTenant(tenantId: string, tenantName: string): Promise<Tenant> {
    // Try to find existing tenant
    let tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    
    if (!tenant) {
      // First time seeing this tenant - provision it
      console.log(`Provisioning new tenant: ${tenantId}`);
      tenant = await this.tenantRepo.save({
        id: tenantId,
        name: tenantName,
        createdAt: new Date(),
      });
      
      // Optional: Set up default data for new tenant
      await this.setupDefaultData(tenant);
    }
    
    return tenant;
  }

  private async setupDefaultData(tenant: Tenant): Promise<void> {
    // Create default categories, settings, etc.
  }
}
```

Use it in your controllers:

```typescript
// controllers/items.controller.ts
@Controller('items')
export class ItemsController {
  constructor(
    private tenantsService: TenantsService,
    private itemsService: ItemsService,
  ) {}

  @Get()
  async findAll(
    @CurrentUser() user: BridgeUser,
    @CurrentTenant() tenant: BridgeTenant,
  ) {
    // Ensure tenant exists before querying
    await this.tenantsService.ensureTenant(tenant.id, tenant.name);
    
    return this.itemsService.findByTenant(tenant.id);
  }
}
```

**Pros:**
- Simple to implement
- No external dependencies
- Works immediately

**Cons:**
- Slight latency on first request (creating records)
- Can't do heavy setup synchronously

### Webhook-Based Provisioning

Bridge/nblocks sends webhooks when tenants and users are created. Listen for these events to provision data proactively.

**Available webhook events:**
- `TENANT_CREATED` - New workspace/account created
- `TENANT_UPDATED` - Workspace details changed
- `TENANT_USER_CREATED` - New user added to workspace
- `TENANT_USER_UPDATED` - User details changed
- `TENANT_USER_DELETED` - User removed from workspace

```typescript
// controllers/webhooks.controller.ts
import { Controller, Post, Body, Headers, UnauthorizedException } from '@nestjs/common';
import { Public } from '@nebulr-group/bridge-nestjs';

interface WebhookPayload {
  event: string;
  data: any;
  timestamp: string;
}

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private tenantsService: TenantsService,
    private usersService: UsersService,
  ) {}

  @Post('nblocks')
  @Public() // Webhooks must be public
  async handleNblocksWebhook(
    @Body() payload: WebhookPayload,
    @Headers('x-webhook-signature') signature: string,
  ) {
    // TODO: Verify webhook signature for security
    // if (!this.verifySignature(payload, signature)) {
    //   throw new UnauthorizedException('Invalid webhook signature');
    // }

    console.log(`Received webhook: ${payload.event}`);

    switch (payload.event) {
      case 'TENANT_CREATED':
        await this.handleTenantCreated(payload.data);
        break;
        
      case 'TENANT_UPDATED':
        await this.handleTenantUpdated(payload.data);
        break;
        
      case 'TENANT_USER_CREATED':
        await this.handleUserCreated(payload.data);
        break;
        
      case 'TENANT_USER_DELETED':
        await this.handleUserDeleted(payload.data);
        break;
    }

    return { received: true };
  }

  private async handleTenantCreated(data: any) {
    await this.tenantsService.createTenant({
      id: data.id,
      name: data.name,
      plan: data.plan,
    });
    
    // Heavy setup can happen here
    await this.tenantsService.setupDefaultData(data.id);
    await this.sendWelcomeEmail(data);
  }

  private async handleTenantUpdated(data: any) {
    await this.tenantsService.updateTenant(data.id, {
      name: data.name,
      plan: data.plan,
    });
  }

  private async handleUserCreated(data: any) {
    await this.usersService.createUser({
      id: data.id,
      tenantId: data.tenantId,
      email: data.email,
      role: data.role,
    });
  }

  private async handleUserDeleted(data: any) {
    await this.usersService.deleteUser(data.id);
    // Clean up user-specific data
  }

  private async sendWelcomeEmail(data: any) {
    // Send welcome email to new tenant owner
  }
}
```

Don't forget to make the webhook endpoint public in your config:

```typescript
BridgeModule.forRoot({
  appId: 'YOUR_APP_ID',
  guard: {
    global: true,
    rules: [
      { path: '/webhooks/*', public: true, methods: ['POST'] },
    ],
  },
})
```

**Pros:**
- Proactive provisioning (data ready before first request)
- Can do heavy/async setup
- Real-time sync with Bridge

**Cons:**
- Webhooks can fail or be delayed
- Need to handle retries/idempotency
- Additional infrastructure

### Recommended Pattern: Webhooks + JIT Fallback

The most robust approach combines both methods:

```typescript
// services/tenants.service.ts
@Injectable()
export class TenantsService {
  constructor(
    @InjectRepository(Tenant)
    private tenantRepo: Repository<Tenant>,
  ) {}

  /**
   * Called from webhook - primary provisioning path
   */
  async createTenant(data: { id: string; name: string; plan?: string }): Promise<Tenant> {
    const existing = await this.tenantRepo.findOne({ where: { id: data.id } });
    if (existing) {
      console.log(`Tenant ${data.id} already exists (JIT beat webhook)`);
      return existing;
    }

    const tenant = await this.tenantRepo.save({
      id: data.id,
      name: data.name,
      plan: data.plan || 'free',
      createdAt: new Date(),
      provisionedVia: 'webhook',
    });

    await this.setupDefaultData(tenant);
    return tenant;
  }

  /**
   * Called on each request - JIT fallback
   */
  async ensureTenant(tenantId: string, tenantName: string): Promise<Tenant> {
    let tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    
    if (!tenant) {
      // Webhook might have failed or been delayed - provision now
      console.log(`JIT provisioning tenant ${tenantId} (webhook missed)`);
      tenant = await this.tenantRepo.save({
        id: tenantId,
        name: tenantName,
        createdAt: new Date(),
        provisionedVia: 'jit',
      });
      
      // Light setup only - heavy setup should happen via webhook
      await this.setupMinimalData(tenant);
    }
    
    return tenant;
  }

  private async setupDefaultData(tenant: Tenant): Promise<void> {
    // Full setup: categories, templates, welcome content, etc.
  }

  private async setupMinimalData(tenant: Tenant): Promise<void> {
    // Minimal setup - just enough to work
  }
}
```

This approach gives you:
- **Webhooks** for proactive, full provisioning
- **JIT** as a safety net for edge cases
- **Resilience** against webhook failures

### Scoping Queries by Tenant

Always scope your database queries by tenant to ensure data isolation:

```typescript
// services/items.service.ts
@Injectable()
export class ItemsService {
  constructor(
    @InjectRepository(Item)
    private itemRepo: Repository<Item>,
  ) {}

  async findByTenant(tenantId: string): Promise<Item[]> {
    return this.itemRepo.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string, tenantId: string): Promise<Item | null> {
    return this.itemRepo.findOne({
      where: { id, tenantId }, // Always include tenantId!
    });
  }

  async create(data: CreateItemDto, tenantId: string, userId: string): Promise<Item> {
    return this.itemRepo.save({
      ...data,
      tenantId,
      createdBy: userId,
    });
  }

  async update(id: string, data: UpdateItemDto, tenantId: string): Promise<Item> {
    const item = await this.findOne(id, tenantId);
    if (!item) {
      throw new NotFoundException('Item not found');
    }
    return this.itemRepo.save({ ...item, ...data });
  }

  async delete(id: string, tenantId: string): Promise<void> {
    const item = await this.findOne(id, tenantId);
    if (!item) {
      throw new NotFoundException('Item not found');
    }
    await this.itemRepo.remove(item);
  }
}
```

**Important:** Never trust the client to provide the tenant ID. Always get it from the authenticated user's token:

```typescript
@Controller('items')
export class ItemsController {
  @Post()
  async create(
    @Body() data: CreateItemDto,
    @CurrentUser() user: BridgeUser,
  ) {
    // tenantId comes from the verified JWT, not from the request body
    return this.itemsService.create(data, user.tenantId, user.id);
  }

  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: BridgeUser,
  ) {
    // Scoped to user's tenant - can't access other tenants' data
    const item = await this.itemsService.findOne(id, user.tenantId);
    if (!item) {
      throw new NotFoundException('Item not found');
    }
    return item;
  }
}
```

## Configuration

### Basic Configuration

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';

@Module({
  imports: [
    BridgeModule.forRoot({
      appId: 'YOUR_APP_ID',
      authBaseUrl: 'https://auth.nblocks.cloud',      // Optional, this is default
      backendlessBaseUrl: 'https://backendless.nblocks.cloud', // Optional, this is default
      debug: false,                                    // Optional, enables logging
      guard: {
        global: true,
        defaultAccess: 'protected',
        rules: [],
      },
    }),
  ],
})
export class AppModule {}
```

### Async Configuration

Use `forRootAsync` for environment-based configuration:

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';

@Module({
  imports: [
    ConfigModule.forRoot(),
    BridgeModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        appId: config.get<string>('BRIDGE_APP_ID'),
        authBaseUrl: config.get<string>('BRIDGE_AUTH_BASE_URL'),
        debug: config.get<string>('BRIDGE_DEBUG') === 'true',
        guard: {
          global: true,
          defaultAccess: 'protected',
          rules: [
            { path: '/health', public: true },
          ],
        },
      }),
    }),
  ],
})
export class AppModule {}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BRIDGE_APP_ID` | Your Bridge application ID | (Required) |
| `BRIDGE_AUTH_BASE_URL` | Base URL for Bridge auth services | `https://auth.nblocks.cloud` |
| `BRIDGE_BACKENDLESS_BASE_URL` | Base URL for Bridge backendless services | `https://backendless.nblocks.cloud` |
| `BRIDGE_DEBUG` | Enable debug logging | `false` |

Example `.env` file:

```env
# Required
BRIDGE_APP_ID=your-app-id-here

# Optional
BRIDGE_AUTH_BASE_URL=https://auth.nblocks.cloud
BRIDGE_BACKENDLESS_BASE_URL=https://backendless.nblocks.cloud
BRIDGE_DEBUG=true
```

### Route Rules Reference

Route rules support the following options:

```typescript
interface RouteRule {
  // Path pattern (supports * wildcard)
  path: string;
  
  // Mark as public (no auth required)
  public?: boolean;
  
  // Required role
  role?: string;
  
  // Required feature flag(s)
  featureFlag?: string | { any: string[] } | { all: string[] };
  
  // HTTP methods this rule applies to (defaults to all)
  methods?: ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')[];
}
```

Example with all options:

```typescript
BridgeModule.forRoot({
  appId: 'YOUR_APP_ID',
  guard: {
    global: true,
    defaultAccess: 'protected',
    rules: [
      // Public health endpoint
      { path: '/health', public: true },
      
      // Public webhooks (POST only)
      { path: '/webhooks/*', public: true, methods: ['POST'] },
      
      // Admin routes require ADMIN role
      { path: '/admin/*', role: 'ADMIN' },
      
      // Owner-only settings
      { path: '/admin/settings', role: 'OWNER' },
      
      // Beta feature requires flag
      { path: '/beta/*', featureFlag: 'beta-access' },
      
      // Premium requires multiple flags
      { path: '/premium/*', featureFlag: { all: ['premium-tier', 'active-subscription'] } },
      
      // Labs requires any of the flags
      { path: '/labs/*', featureFlag: { any: ['labs-v1', 'labs-v2', 'internal'] } },
    ],
  },
})
```

## Error Responses

### 401 Unauthorized

Returned when token is missing or invalid:

```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "message": "Access token missing or invalid"
}
```

### 403 Forbidden (Role)

Returned when user doesn't have required role:

```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "Role 'ADMIN' required"
}
```

### 403 Forbidden (Feature Flag)

Returned when feature flag is not enabled:

```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "Feature flag 'beta-access' is not enabled"
}
```

