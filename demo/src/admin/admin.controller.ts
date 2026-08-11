import { Controller, Get } from '@nestjs/common';
import { RequireRole, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

/**
 * Admin controller - all routes require ADMIN role.
 * Role gating is applied at the controller level via @RequireRole('ADMIN');
 * the global BridgeAuthGuard (configured in app.module.ts) enforces it.
 */
@Controller('admin')
@RequireRole('ADMIN')
export class AdminController {
  /**
   * List users - requires ADMIN role (from controller-level @RequireRole)
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
   * Get dashboard - uses the controller-level ADMIN role
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

