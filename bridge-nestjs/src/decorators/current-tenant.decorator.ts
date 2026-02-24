import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { BridgeTenant } from '../types/tenant';

/**
 * Parameter decorator to extract the tenant from the request.
 * 
 * @example
 * ```typescript
 * @Get()
 * @UseGuards(BridgeAuthGuard)
 * findAll(@CurrentTenant() tenant: BridgeTenant) {
 *   return this.service.findByTenant(tenant.id);
 * }
 * ```
 */
export const CurrentTenant = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): BridgeTenant | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.bridgeTenant;
  },
);

