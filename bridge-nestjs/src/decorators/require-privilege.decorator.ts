import { SetMetadata } from '@nestjs/common';

export const REQUIRED_PRIVILEGE_KEY = 'bridge:requiredPrivilege';

/**
 * API tokens only: the scope an API token (x-api-key) must carry to call this
 * route or controller. Enforced by BridgeAuthGuard for machine callers.
 *
 * It is not a gate on a person. A signed-in user (Authorization: Bearer) is
 * not checked against it; gate people with `@RequireFeatureFlag` and a flag
 * rule on a privilege (`privileges contains "USER_READ"`).
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
