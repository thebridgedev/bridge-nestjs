import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import {
  BridgeTenant,
  CurrentTenant,
  RequireQuota,
  SyncQuota,
} from '@nebulr-group/bridge-nestjs';
import { TicketsService } from './tickets.service';

/**
 * Plan limits as decorators (TBP-704).
 *
 * - `tickets` is a GAUGE: tickets exist and deleting one frees room. The app
 *   counts them (`current`); the plugin refuses a create at the limit and sets
 *   Bridge's copy of the count after every successful create and delete.
 * - `exports` is a COUNTER: an export happened. Bridge counts reported events;
 *   the plugin reports one after each successful export, deduplicated by the
 *   request's `Idempotency-Key` header.
 *
 * A refusal is 402 `{ code: 'QUOTA_EXCEEDED', metric, used, limit, fix }`.
 * Calling the API directly (curl, a script) hits exactly the same gate.
 */
@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  list(@CurrentTenant() tenant: BridgeTenant) {
    return this.tickets.list(tenant.id);
  }

  @Post()
  @RequireQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  create(@CurrentTenant() tenant: BridgeTenant, @Body() body: { title?: string }) {
    return this.tickets.create(tenant.id, body?.title ?? 'Untitled');
  }

  @Delete(':id')
  @SyncQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  remove(@CurrentTenant() tenant: BridgeTenant, @Param('id') id: string) {
    this.tickets.remove(tenant.id, id);
    return { deleted: id };
  }

  /*
   * A number, not a gate: the plan's `exports` limit. Who may export at all
   * would be a flag (`@RequireFeatureFlag`) with its rule on the plan feature.
   */
  @Post(':id/export')
  @RequireQuota('exports')
  export(@CurrentTenant() tenant: BridgeTenant, @Param('id') id: string) {
    const ticket = this.tickets.get(tenant.id, id);
    return { exported: ticket.id, format: 'csv' };
  }
}
