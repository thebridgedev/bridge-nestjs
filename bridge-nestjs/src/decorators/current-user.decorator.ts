import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { BridgeUser } from '../types/user';

/**
 * Parameter decorator to extract the authenticated user from the request.
 * 
 * @example
 * ```typescript
 * @Get()
 * @UseGuards(BridgeAuthGuard)
 * findAll(@CurrentUser() user: BridgeUser) {
 *   return this.service.findByUser(user.id);
 * }
 * ```
 */
export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): BridgeUser | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.bridgeUser;
  },
);

