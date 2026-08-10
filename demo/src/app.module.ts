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
      // `apiBaseUrl` is the single base the plugin derives auth + account URLs
      // from. This file previously passed `authBaseUrl` / `backendlessBaseUrl`,
      // neither of which exists on BridgeConfig — so the demo (and every e2e
      // suite that boots it) failed to compile, and had it compiled the ignored
      // override would have silently left apiBaseUrl on its production default.
      appId: process.env.BRIDGE_APP_ID || 'demo-app-id',
      apiBaseUrl: process.env.BRIDGE_API_BASE_URL,
      debug: process.env.BRIDGE_DEBUG === 'true',
      guard: {
        global: true,
        defaultAccess: 'protected',
        rules: [
          // Public routes. A RouteRule carries a `privilege`, and 'ANONYMOUS'
          // is what the guard short-circuits on — there is no `public: true`
          // rule form (that's the `@Public()` decorator, which /health also
          // already uses).
          { path: '/health', privilege: 'ANONYMOUS' },
          { path: '/api/public/*', privilege: 'ANONYMOUS' },
        ],
        // Role and feature-flag gating are decorator-driven, not rule-driven:
        // `@RequireRole` / `@RequireFeatureFlag` on the handler. The demo
        // controllers already declare them that way — see
        // admin.controller.ts (@RequireRole('OWNER')) and
        // beta.controller.ts (@RequireFeatureFlag). The `role:` / `featureFlag:`
        // rules that used to sit here were never a supported RouteRule shape.
      },
    }),
  ],
  controllers: [AppController, ItemsController, AdminController, BetaController, ForwardController],
})
export class AppModule {}

