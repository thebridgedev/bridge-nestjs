import { Controller, Get } from '@nestjs/common';
import { CurrentUser, CurrentTenant, BridgeUser, BridgeTenant } from '@nebulr-group/bridge-nestjs';

@Controller('items')
export class ItemsController {
  /**
   * Protected endpoint - requires authentication
   * Uses @CurrentUser() and @CurrentTenant() decorators to access user context
   */
  @Get()
  findAll(
    @CurrentUser() user: BridgeUser,
    @CurrentTenant() tenant: BridgeTenant,
  ) {
    return {
      message: 'Protected items endpoint',
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      tenant: tenant ? {
        id: tenant.id,
        name: tenant.name,
      } : null,
      items: [
        { id: 1, name: 'Item 1', tenantId: tenant?.id },
        { id: 2, name: 'Item 2', tenantId: tenant?.id },
      ],
    };
  }

  /**
   * Get a specific item by ID
   */
  @Get(':id')
  findOne(
    @CurrentUser() user: BridgeUser,
  ) {
    return {
      message: 'Item details',
      userId: user.id,
      item: { id: 1, name: 'Item 1' },
    };
  }
}

