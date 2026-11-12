import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentActor, Flag, Meter, RequireFlag, type Actor } from '@nebulr-group/bridge-nestjs';

interface Ticket {
  id: number;
  workspace: string;
  title: string;
}

const tickets: Ticket[] = [];

@Controller('tickets')
export class TicketsController {
  /** Gated by a flag: its rule in Bridge says who may (a privilege, a plan feature, a rollout). */
  @RequireFlag('tickets')
  @Get()
  list(@CurrentActor('workspaceId') workspace: string, @Flag('tickets-page-size', 20) pageSize: number) {
    return tickets.filter((ticket) => ticket.workspace === workspace).slice(0, pageSize);
  }

  /** A plan limit is a flag rule over the count; the code only counts. */
  @RequireFlag('tickets-create')
  @Meter('tickets.created')
  @Post()
  create(@CurrentActor() actor: Actor, @Body() body: { title?: string }) {
    const ticket = { id: tickets.length + 1, workspace: actor.workspaceId ?? '', title: body.title ?? 'Untitled' };
    tickets.push(ticket);
    return ticket;
  }
}
