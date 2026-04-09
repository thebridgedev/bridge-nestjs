import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { BridgeTenant } from '../types/tenant';
import { getRequestFromContext } from './context-utils';

/**
 * Parameter decorator to extract the tenant from the request.
 * Works in both HTTP controllers and GraphQL resolvers.
 *
 * @example
 * ```typescript
 * @Get()
 * findAll(@CurrentTenant() tenant: BridgeTenant) {
 *   return this.service.findByTenant(tenant.id);
 * }
 *
 * @Query()
 * getTenant(@CurrentTenant() tenant: BridgeTenant) {
 *   return this.service.find(tenant.id);
 * }
 * ```
 */
export const CurrentTenant = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): BridgeTenant | undefined => {
    const request = getRequestFromContext(ctx);
    return request?.bridgeTenant;
  },
);

