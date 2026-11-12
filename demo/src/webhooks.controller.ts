import { Controller, HttpCode, Post } from '@nestjs/common';
import { BridgeWebhook, WebhookEvent, type BridgeWebhookEvent } from '@nebulr-group/bridge-nestjs';

/** The demo keeps the last events it received, to show them. */
export const received: BridgeWebhookEvent[] = [];

@Controller('webhooks')
export class WebhooksController {
  /** Bridge's webhooks: checked by signature, not by a token. */
  @BridgeWebhook()
  @HttpCode(204)
  @Post('bridge')
  receive(@WebhookEvent() event: BridgeWebhookEvent) {
    // Bridge may deliver an event more than once: handle each id once.
    if (event.id === null || !received.some((seen) => seen.id === event.id)) received.push(event);
  }
}
