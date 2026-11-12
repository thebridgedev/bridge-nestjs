import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';
import { AppController } from './app.controller';
import { TeamController } from './team.controller';
import { TicketsController } from './tickets.controller';
import { WebhooksController } from './webhooks.controller';

/**
 * The demo: every route needs a signed-in caller unless it says `@Public()`,
 * and every gate is a flag.
 *
 *   BRIDGE_ISSUER            the app's issuer (required)
 *   BRIDGE_APP_KEY           the app's own key: "count this" and the management client
 *   BRIDGE_WEBHOOK_SECRETS   the webhook signing secret; two, comma-separated, during a rotation
 */
@Module({
  imports: [
    // The issuer, app key and webhook secrets come from the environment.
    BridgeModule.forRoot({
      guard: { global: true },
      debug: process.env.BRIDGE_DEBUG === 'true',
    }),
  ],
  controllers: [AppController, TicketsController, TeamController, WebhooksController],
})
export class AppModule {}
