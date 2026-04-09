# Multi-Tenancy Patterns

### Data separation strategies

**1. Column-based separation (recommended for most cases)**

Add a `tenantId` column to your tables and filter by it:

```typescript
@Entity()
export class Item {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  tenantId: string;

  @Column()
  name: string;

  @Column()
  createdBy: string;
}
```

**2. Schema-based separation** — separate database schema per tenant (more isolation, more complexity).

**3. Database-based separation** — completely separate databases per tenant (maximum isolation, highest complexity).

### Just-in-Time (JIT) provisioning

When you see a new tenant/user ID in a request, create the record automatically:

```typescript
@Injectable()
export class TenantsService {
  constructor(
    @InjectRepository(Tenant)
    private tenantRepo: Repository<Tenant>,
  ) {}

  async ensureTenant(tenantId: string, tenantName: string): Promise<Tenant> {
    let tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });

    if (!tenant) {
      tenant = await this.tenantRepo.save({
        id: tenantId,
        name: tenantName,
        createdAt: new Date(),
      });
      await this.setupDefaultData(tenant);
    }

    return tenant;
  }

  private async setupDefaultData(tenant: Tenant): Promise<void> {
    // Create default categories, settings, etc.
  }
}
```

### Webhook-based provisioning

Bridge sends webhooks when tenants and users are created:

- `TENANT_CREATED` — new workspace/account created
- `TENANT_UPDATED` — workspace details changed
- `TENANT_USER_CREATED` — new user added to workspace
- `TENANT_USER_UPDATED` — user details changed
- `TENANT_USER_DELETED` — user removed from workspace

```typescript
import { Controller, Post, Body, Headers } from '@nestjs/common';
import { Public } from '@nebulr-group/bridge-nestjs';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private tenantsService: TenantsService,
    private usersService: UsersService,
  ) {}

  @Post('bridge')
  @Public()
  async handleBridgeWebhook(
    @Body() payload: { event: string; data: any; timestamp: string },
    @Headers('x-webhook-signature') signature: string,
  ) {
    switch (payload.event) {
      case 'TENANT_CREATED':
        await this.tenantsService.createTenant(payload.data);
        break;
      case 'TENANT_USER_CREATED':
        await this.usersService.createUser(payload.data);
        break;
      // ... handle other events
    }

    return { received: true };
  }
}
```

Make the webhook endpoint public in your config:

```typescript
BridgeModule.forRoot({
  appId: 'YOUR_APP_ID',
  guard: {
    global: true,
    rules: [
      { path: '/webhooks/*', privilege: 'ANONYMOUS' },
    ],
  },
})
```

### Recommended pattern: Webhooks + JIT fallback

The most robust approach combines both methods:

```typescript
@Injectable()
export class TenantsService {
  // Called from webhook — primary provisioning path
  async createTenant(data: { id: string; name: string; plan?: string }): Promise<Tenant> {
    const existing = await this.tenantRepo.findOne({ where: { id: data.id } });
    if (existing) return existing; // JIT already handled it

    const tenant = await this.tenantRepo.save({
      ...data,
      provisionedVia: 'webhook',
      createdAt: new Date(),
    });
    await this.setupDefaultData(tenant);
    return tenant;
  }

  // Called on each request — JIT fallback
  async ensureTenant(tenantId: string, tenantName: string): Promise<Tenant> {
    let tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });

    if (!tenant) {
      tenant = await this.tenantRepo.save({
        id: tenantId,
        name: tenantName,
        provisionedVia: 'jit',
        createdAt: new Date(),
      });
      await this.setupMinimalData(tenant);
    }

    return tenant;
  }
}
```

### Scoping queries by tenant

Always scope database queries by tenant to ensure data isolation. Never trust the client to provide the tenant ID — always get it from the authenticated user's token:

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
    // Scoped to user's tenant — can't access other tenants' data
    const item = await this.itemsService.findOne(id, user.tenantId);
    if (!item) throw new NotFoundException('Item not found');
    return item;
  }
}
```
