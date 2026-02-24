import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'bridge:isPublic';

/**
 * Decorator to mark a route as public (no authentication required).
 * This decorator overrides any global guard or route rule configuration.
 * 
 * @example
 * ```typescript
 * @Get('health')
 * @Public()
 * healthCheck() {
 *   return { status: 'ok' };
 * }
 * ```
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

