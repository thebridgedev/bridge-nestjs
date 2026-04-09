# Frontend Integration & Token Forwarding

## Token Forwarding Between Services

Use `BridgeHttpService` to call downstream services while forwarding the authenticated user's token.

### Basic token forwarding

```typescript
import { Controller, Get, Post, Body, Req } from '@nestjs/common';
import { BridgeHttpService } from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';

@Controller('orders')
export class OrdersController {
  constructor(private readonly bridgeHttp: BridgeHttpService) {}

  @Get()
  async getOrders(@Req() req: Request) {
    return this.bridgeHttp.get(
      'http://inventory-service/items',
      req.bridgeAccessToken,
    );
  }

  @Post()
  async createOrder(@Body() dto: CreateOrderDto, @Req() req: Request) {
    return this.bridgeHttp.post(
      'http://order-service/orders',
      dto,
      req.bridgeAccessToken,
    );
  }
}
```

`BridgeHttpService` provides `get`, `post`, `put`, `patch`, and `delete` methods. All accept an optional bearer token and optional `RequestInit` options.

### Calling public endpoints

If the downstream endpoint requires no auth, omit the token:

```typescript
@Get('catalog')
async getCatalog() {
  return this.bridgeHttp.get('http://catalog-service/products');
}
```

### Error handling

`BridgeHttpService` throws `BridgeHttpError` on non-2xx responses:

```typescript
import { BridgeHttpService, BridgeHttpError } from '@nebulr-group/bridge-nestjs';

@Get('inventory')
async getInventory(@Req() req: Request) {
  try {
    return await this.bridgeHttp.get(
      'http://inventory-service/stock',
      req.bridgeAccessToken,
    );
  } catch (error) {
    if (error instanceof BridgeHttpError) {
      console.log(error.status); // HTTP status code
      console.log(error.url);    // Request URL
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

## Frontend Integration

The Bridge NestJS plugin expects the access token in the `Authorization` header using the Bearer scheme:

```
Authorization: Bearer <access_token>
```

The flow is:
1. User logs in via Bridge (frontend handles this)
2. Frontend receives and stores the access token
3. Frontend includes the token in API requests to your backend
4. Bridge NestJS validates the token and extracts user/tenant info

### Sending tokens with Fetch

```typescript
const accessToken = getAccessToken();

const response = await fetch('http://localhost:3000/api/items', {
  method: 'GET',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  },
});

const data = await response.json();
```

### Sending tokens with Axios

```typescript
import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:3000/api',
});

api.interceptors.request.use((config) => {
  const accessToken = getAccessToken();
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

const response = await api.get('/items');
```

### Using Bridge Svelte

```svelte
<script lang="ts">
  import { auth } from '@nebulr-group/bridge-svelte';

  async function fetchItems() {
    const tokens = auth.getToken();
    if (!tokens?.accessToken) return;

    const response = await fetch('http://localhost:3000/api/items', {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
      },
    });

    return response.json();
  }
</script>
```

### Using Bridge React

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
          Authorization: `Bearer ${accessToken}`,
        },
      });

      setItems(await response.json());
    }
    fetchItems();
  }, [isAuthenticated, getAccessToken]);

  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>{item.name}</li>
      ))}
    </ul>
  );
}
```
