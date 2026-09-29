import { Controller, Get } from '@nestjs/common';
import { RequireFeatureFlag, CurrentUser, BridgeUser } from '@nebulr-group/bridge-nestjs';

/**
 * Admin controller — every gate is a flag (TBP-705).
 *
 * `admin-area` is ruled on a privilege, e.g. `privileges contains "USER_WRITE"`
 * (in the default setup ADMIN and OWNER hold it). The code asks the flag and
 * never reads the role; the global BridgeAuthGuard (app.module.ts) enforces it.
 */
@Controller('admin')
@RequireFeatureFlag('admin-area')
export class AdminController {
  /**
   * List users — the controller-level `admin-area` flag.
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
   * Settings — its own flag, `admin-settings`, ruled on the privilege that
   * only the workspace owner holds in the default setup (e.g.
   * `privileges contains "TENANT_WRITE"`). Overrides the controller flag.
   */
  @Get('settings')
  @RequireFeatureFlag('admin-settings')
  getSettings(@CurrentUser() user: BridgeUser) {
    return {
      message: 'Admin settings',
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
   * Dashboard — the controller-level `admin-area` flag.
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

