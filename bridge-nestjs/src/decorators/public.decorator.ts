import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'bridge:isPublic';

/**
 * Opens a route (or a whole controller) to callers without a credential. A
 * credential that comes anyway is still checked, so `@CurrentActor()` works
 * for signed-in callers of a public route.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
