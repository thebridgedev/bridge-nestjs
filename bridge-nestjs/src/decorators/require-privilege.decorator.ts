import { SetMetadata } from '@nestjs/common';

export const REQUIRED_PRIVILEGE_KEY = 'bridge:requiredPrivilege';

/**
 * Decorator to require a specific API token privilege for a route or controller.
 * Enforced by BridgeAuthGuard when an API token (x-api-key) is used.
 *
 * User JWTs (Authorization: Bearer) bypass this check for backward compatibility.
 *
 * @param privilege - The required privilege key (e.g., 'USER_READ', 'TENANT_WRITE')
 *
 * @example
 * ```typescript
 * @Controller('users')
 * @UseGuards(BridgeAuthGuard)
 * export class UsersController {
 *   @Get()
 *   @RequirePrivilege('USER_READ')
 *   listUsers() { ... }
 * }
 * ```
 */
export const RequirePrivilege = (privilege: string) =>
  SetMetadata(REQUIRED_PRIVILEGE_KEY, privilege);
