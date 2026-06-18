import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';
import { AppController } from './app.controller';
import { ItemsController } from './items/items.controller';
import { AdminController } from './admin/admin.controller';
import { BetaController } from './beta/beta.controller';
import { ForwardController } from './forward/forward.controller';

@Module({
  imports: [
    BridgeModule.forRoot({
      appId: process.env.BRIDGE_APP_ID || 'demo-app-id',
      apiBaseUrl: process.env.BRIDGE_API_BASE_URL,
      debug: process.env.BRIDGE_DEBUG === 'true',
      guard: {
        global: true,
        defaultAccess: 'protected',
        rules: [
          // Public routes — only ANONYMOUS/privilege/plan rules belong in central
          // guard config. Role and feature-flag gating live on the controllers
          // (see @RequireRole / @RequireFeatureFlag below).
          { path: '/health', privilege: 'ANONYMOUS' },
          { path: '/api/public/*', privilege: 'ANONYMOUS' },

          // Role gating → @RequireRole('ADMIN') on AdminController.
          // Feature-flag gating → @RequireFeatureFlag('beta-access') on BetaController.
          // /premium/* has no dedicated controller, so there is no central rule for
          // it; gate premium endpoints with @RequireFeatureFlag(...) on their controller.
        ],
      },
    }),
  ],
  controllers: [AppController, ItemsController, AdminController, BetaController, ForwardController],
})
export class AppModule {}

