import { applyDecorators, CallHandler, ExecutionContext, Inject, Injectable, Logger, NestInterceptor, SetMetadata, UseInterceptors } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { BridgeServer } from '@nebulr-group/bridge-auth-core/server';
import { Observable, tap } from 'rxjs';
import { BRIDGE_SERVER } from '../options';
import { bridgeStateOf, requestOf } from '../request-context';

export const METER_KEY = 'bridge:meter';

export interface MeterMetadata {
  metric: string;
  quantity: number;
}

/**
 * "Count this": once the handler succeeds, adds `quantity` to the metric for
 * the caller's workspace. Bridge keeps the count; a limit on it is a flag's
 * rule, so gate the route with `@RequireFlag` and let the rule compare.
 *
 * Counted in batches every few seconds; needs the module's `appKey`.
 *
 * @example
 *   @Post() @RequireFlag('tickets-create') @Meter('tickets.created')
 */
export function Meter(metric: string, quantity = 1) {
  return applyDecorators(SetMetadata(METER_KEY, { metric, quantity } satisfies MeterMetadata), UseInterceptors(BridgeMeterInterceptor));
}

@Injectable()
export class BridgeMeterInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Bridge');

  constructor(
    private readonly reflector: Reflector,
    @Inject(BRIDGE_SERVER) private readonly server: BridgeServer,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meter = this.reflector.get<MeterMetadata | undefined>(METER_KEY, context.getHandler());
    if (meter === undefined) return next.handle();
    return next.handle().pipe(
      tap({
        complete: () => {
          const request = requestOf(context);
          const actor = request === null ? null : (bridgeStateOf(request)?.actor ?? null);
          if (actor === null || actor.workspaceId === null) {
            this.logger.warn(`Not counted: "${meter.metric}" needs a caller acting in a workspace.`);
            return;
          }
          try {
            this.server.usage.count(actor, meter.metric, meter.quantity);
          } catch (error) {
            // The work is done: a count that cannot be queued is logged, never turned into a failed call.
            this.logger.error(`Not counted: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      }),
    );
  }
}
