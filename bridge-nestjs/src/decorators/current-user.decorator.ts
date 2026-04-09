import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { BridgeUser } from '../types/user';
import { getRequestFromContext } from './context-utils';

/**
 * Parameter decorator to extract the authenticated user from the request.
 * Works in both HTTP controllers and GraphQL resolvers.
 *
 * @example
 * ```typescript
 * @Get()
 * findAll(@CurrentUser() user: BridgeUser) {
 *   return this.service.findByUser(user.id);
 * }
 *
 * @Query()
 * listApps(@CurrentUser() user: BridgeUser) {
 *   return this.service.list(user.tenantId);
 * }
 * ```
 */
export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): BridgeUser | undefined => {
    const request = getRequestFromContext(ctx);
    return request?.bridgeUser;
  },
);

