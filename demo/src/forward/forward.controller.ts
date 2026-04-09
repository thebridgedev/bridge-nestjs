import { Controller, Get, Req } from '@nestjs/common';
import { BridgeHttpService } from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';

/**
 * Demonstrates token forwarding with BridgeHttpService.
 *
 * The user's verified access token is forwarded to a downstream
 * service call, so the downstream service can also authenticate
 * and authorize the user.
 */
@Controller('forward')
export class ForwardController {
  constructor(private readonly bridgeHttpService: BridgeHttpService) {}

  /**
   * Calls GET /items on localhost:3000, forwarding the authenticated user's token.
   * In a real app, replace the URL with the downstream service address.
   */
  @Get('items')
  async forwardItems(@Req() req: Request) {
    const port = process.env.PORT || 3000;
    return this.bridgeHttpService.get(
      `http://localhost:${port}/items`,
      req.bridgeAccessToken,
    );
  }
}
