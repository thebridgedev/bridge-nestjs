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
          // Public routes. A rule's `privilege` is 'ANONYMOUS' or
          // 'AUTHENTICATED' — whether the route needs a signed-in caller.
          // (`@Public()` on a handler does the same; /health uses both.)
          { path: '/health', privilege: 'ANONYMOUS' },
          { path: '/api/public/*', privilege: 'ANONYMOUS' },

          // Who gets a route is a flag, whose rule says why (a privilege, a
          // plan feature, a rollout): `@RequireFeatureFlag` on the handler
          // (admin.controller.ts, beta.controller.ts) or a rule's
          // `featureFlag`, e.g.
          //   { path: '/reports/*', privilege: 'AUTHENTICATED', featureFlag: 'reports' }
        ],
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

