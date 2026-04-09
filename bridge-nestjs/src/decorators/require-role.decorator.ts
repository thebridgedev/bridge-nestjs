import { SetMetadata } from '@nestjs/common';

export const REQUIRED_ROLE_KEY = 'bridge:requiredRole';

/**
 * Decorator to require a specific role for a route or controller.
 * This decorator overrides any role requirement from route rules configuration.
 * 
 * @param role - The required role (e.g., 'ADMIN', 'OWNER')
 * 
 * @example
 * ```typescript
 * @Controller('admin')
 * @UseGuards(BridgeAuthGuard)
 * @RequireRole('ADMIN')
 * export class AdminController {
 *   @Get('settings')
 *   @RequireRole('OWNER') // Override controller-level role
 *   getSettings() { ... }
 * }
 * ```
 */
export const RequireRole = (role: string) => SetMetadata(REQUIRED_ROLE_KEY, role);

