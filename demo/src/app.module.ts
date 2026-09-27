import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';
import { AppController } from './app.controller';
import { ItemsController } from './items/items.controller';
import { AdminController } from './admin/admin.controller';
import { BetaController } from './beta/beta.controller';
import { ForwardController } from './forward/forward.controller';
import { TicketsController } from './tickets/tickets.controller';
import { TicketsService } from './tickets/tickets.service';

@Module({
  imports: [
    BridgeModule.forRoot({
      // `appId`, `apiBaseUrl` and `debug` come from BRIDGE_APP_ID,
      // BRIDGE_API_BASE_URL and BRIDGE_DEBUG — forRoot() reads them when they
      // are not passed (TBP-704). Pass them here to override the environment.
      guard: {
        global: true,
        defaultAccess: 'protected',
        rules: [
          // Public routes. A RouteRule carries a `privilege`, and 'ANONYMOUS'
          // is what the guard short-circuits on — there is no `public: true`
          // rule form (that's the `@Public()` decorator, which /health also
          // already uses). Only ANONYMOUS/privilege/plan rules belong in
          // central guard config.
          { path: '/health', privilege: 'ANONYMOUS' },
          { path: '/api/public/*', privilege: 'ANONYMOUS' },

          // /premium/* has no dedicated controller, so there is no central rule
          // for it; gate premium endpoints with @RequireFeatureFlag(...) on
          // their controller.
        ],
        // Role gating is decorator-driven, not rule-driven: `@RequireRole` on
        // the handler — see admin.controller.ts (@RequireRole('OWNER')). The
        // `role:` rules that used to sit here were never a supported RouteRule
        // shape. Feature flags can go either way: `@RequireFeatureFlag` on the
        // handler (see beta.controller.ts) or, since TBP-472, a central rule's
        // `featureFlag:` / `entitlement:` field.
      },
    }),
  ],
  controllers: [
    AppController,
    ItemsController,
    AdminController,
    BetaController,
    ForwardController,
    TicketsController,
  ],
  providers: [TicketsService],
})
export class AppModule {}

