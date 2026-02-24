import { Controller, Get } from '@nestjs/common';
import { RequireRole, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

/**
 * Admin controller - all routes require ADMIN role by config rule
 */
@Controller('admin')
export class AdminController {
  /**
   * List users - requires ADMIN role (from config rule)
   */
  @Get('users')
  listUsers(@CurrentUser() user: BridgeUser) {
    return {
      message: 'Admin users list',
      requestedBy: user.email,
      role: user.role,
      users: [
        { id: '1', email: 'user1@example.com', role: 'USER' },
        { id: '2', email: 'user2@example.com', role: 'ADMIN' },
      ],
    };
  }

  /**
   * Get settings - requires OWNER role (decorator overrides config)
   */
  @Get('settings')
  @RequireRole('OWNER')
  getSettings(@CurrentUser() user: BridgeUser) {
    return {
      message: 'Admin settings (OWNER only)',
      requestedBy: user.email,
      role: user.role,
      settings: {
        feature1: true,
        feature2: false,
        maxUsers: 100,
      },
    };
  }

  /**
   * Get dashboard - uses default ADMIN role from config
   */
  @Get('dashboard')
  getDashboard(@CurrentUser() user: BridgeUser) {
    return {
      message: 'Admin dashboard',
      requestedBy: user.email,
      stats: {
        totalUsers: 42,
        activeUsers: 35,
        revenue: 12500,
      },
    };
  }
}

