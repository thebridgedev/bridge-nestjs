import { SetMetadata } from '@nestjs/common';

export type AuthType = 'jwt' | 'api_token' | 'both';

export const ACCEPT_AUTH_KEY = 'bridge:acceptAuth';

/**
 * Decorator to restrict which authentication type an endpoint accepts.
 *
 * - `'jwt'`       — only user JWT (Authorization: Bearer) is accepted; x-api-key → 401
 * - `'api_token'` — only API token (x-api-key) is accepted; Authorization Bearer → 401
 * - `'both'`      — either auth type accepted (default when decorator is omitted)
 *
 * @example
 * ```typescript
 * @Controller('account/api-token/me')
 * @AcceptAuth('jwt')
 * @UseGuards(BridgeAuthGuard)
 * export class ApiTokenUserController { ... }
 * ```
 */
export const AcceptAuth = (type: AuthType) => SetMetadata(ACCEPT_AUTH_KEY, type);
