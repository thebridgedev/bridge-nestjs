# Error Handling & Responses

## Error Handling and Token Refresh

The `BridgeAuthGuard` returns RFC 6750-compliant `WWW-Authenticate` response headers so your frontend can distinguish between error types and handle them appropriately.

### Error codes

| `WWW-Authenticate` error | Meaning | Recommended action |
|---|---|---|
| `missing_token` | No Authorization header was sent | Redirect to login |
| `expired_token` | Token signature is valid but past expiry | Attempt silent refresh, then redirect |
| `invalid_token` | Token is malformed, tampered, or uses an unknown key | Redirect to login |

### Frontend auto-refresh pattern

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
      try {
        await auth.refresh();
        const newToken = auth.getAccessToken();
        return fetch(`http://localhost:3000${endpoint}`, {
          ...options,
          headers: {
            ...options.headers,
            Authorization: `Bearer ${newToken}`,
            'Content-Type': 'application/json',
          },
        }).then((r) => r.json());
      } catch {
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

## Error Responses

### 401 Unauthorized

Returned when token is missing, expired, or invalid. Includes RFC 6750 `WWW-Authenticate` header:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="expired_token", error_description="The access token has expired"
```

```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "message": "The access token has expired"
}
```

Auth type rejection (e.g., API token sent to a `@AcceptAuth('jwt')` endpoint):

```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "message": "auth type not accepted"
}
```

### 403 Forbidden

Returned when authenticated but lacking required role, privilege, or feature flag:

**Role check failed:**
```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "Role 'ADMIN' required"
}
```

**Privilege check failed:**
```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "Privilege 'USER_READ' required"
}
```

**Feature flag not enabled:**
```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "Feature flag 'beta-access' is not enabled"
}
```

### TokenVerificationError

Thrown by `JwksService` when token verification fails. Error codes:

| Code | Meaning |
|------|---------|
| `TOKEN_EXPIRED` | JWT has expired |
| `TOKEN_INVALID` | JWT is malformed or invalid |
| `JWKS_NO_MATCH` | No matching key found in JWKS endpoint |
| `CLAIM_VALIDATION_FAILED` | Token claim validation failed (e.g., wrong issuer or audience) |
| `APP_MISMATCH` | API token was issued for a different app ID |
| `UNKNOWN_ERROR` | Unexpected verification error |

These are mapped to RFC 6750 `WWW-Authenticate` errors by the guard:

| Error Code | RFC 6750 Error | Description |
|------------|----------------|-------------|
| `TOKEN_EXPIRED` | `expired_token` | The access token has expired |
| `TOKEN_INVALID` | `invalid_token` | The access token is invalid |
| `JWKS_NO_MATCH` | `invalid_token` | The access token signature could not be verified |
| `CLAIM_VALIDATION_FAILED` | `invalid_token` | The access token claim validation failed |
| `APP_MISMATCH` | `invalid_token` | The access token was issued for a different application |

### BridgeHttpError

Thrown by `BridgeHttpService` when a downstream HTTP call returns a non-2xx response:

```typescript
class BridgeHttpError extends Error {
  readonly status: number;  // HTTP status code
  readonly url: string;     // Request URL
}
```

```typescript
try {
  await this.bridgeHttp.get('http://service-b/data', token);
} catch (error) {
  if (error instanceof BridgeHttpError) {
    console.log(error.status); // e.g., 404
    console.log(error.url);    // 'http://service-b/data'
  }
}
```
