import { Injectable, NotFoundException } from '@nestjs/common';

export interface Ticket {
  id: string;
  title: string;
}

/**
 * The demo's own ticket store — in memory, per tenant. In a real app this is
 * your database. It is the source of truth for how many tickets exist, which
 * is why the `tickets` quota is a gauge: the app counts, Bridge keeps a copy.
 */
@Injectable()
export class TicketsService {
  private readonly byTenant = new Map<string, Ticket[]>();
  private seq = 0;

  countFor(tenantId: string): number {
    return this.byTenant.get(tenantId)?.length ?? 0;
  }

  list(tenantId: string): Ticket[] {
    return this.byTenant.get(tenantId) ?? [];
  }

  create(tenantId: string, title: string): Ticket {
    const ticket = { id: `t${++this.seq}`, title };
    this.byTenant.set(tenantId, [...this.list(tenantId), ticket]);
    return ticket;
  }

  remove(tenantId: string, id: string): void {
    const tickets = this.list(tenantId);
    if (!tickets.some((t) => t.id === id)) throw new NotFoundException(`No ticket ${id}`);
    this.byTenant.set(
      tenantId,
      tickets.filter((t) => t.id !== id),
    );
  }

  get(tenantId: string, id: string): Ticket {
    const ticket = this.list(tenantId).find((t) => t.id === id);
    if (!ticket) throw new NotFoundException(`No ticket ${id}`);
    return ticket;
  }
}
