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
      authBaseUrl: process.env.BRIDGE_AUTH_BASE_URL,
      backendlessBaseUrl: process.env.BRIDGE_BACKENDLESS_BASE_URL,
      debug: process.env.BRIDGE_DEBUG === 'true',
      guard: {
        global: true,
        defaultAccess: 'protected',
        rules: [
          // Public routes
          { path: '/health', public: true },
          { path: '/api/public/*', public: true },
          
          // Role-based routes
          { path: '/admin/*', role: 'ADMIN' },
          
          // Feature flag routes
          { path: '/beta/*', featureFlag: 'beta-access' },
          { path: '/premium/*', featureFlag: { all: ['premium-tier', 'active-subscription'] } },
        ],
      },
    }),
  ],
  controllers: [AppController, ItemsController, AdminController, BetaController, ForwardController],
})
export class AppModule {}

