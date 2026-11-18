// The interceptor behind @RequireQuota, @SyncQuota and @RequireEntitlement.
//
// An interceptor rather than a guard so it always runs after every guard,
// BridgeAuthGuard included, whatever order the decorators are written in:
// by the time it runs, the request's caller is verified.
//
// Before the handler: the entitlement (403), then one unit held for the
// quota (402).
// After the handler: when it answered 2xx, the unit is confirmed and a gauge
// is set to its count. A handler that throws, or that sets a 4xx/5xx status
// itself, gives the unit back and records nothing.

import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import type { UsageHold } from '@nebulr-group/bridge-auth-core/server';
import { catchError, concatMap, finalize, from, Observable, switchMap, throwError } from 'rxjs';

import { REQUIRED_ENTITLEMENT_KEY, REQUIRED_QUOTA_KEY, SYNC_QUOTA_KEY, type QuotaMetadata, type QuotaTenant } from './quota.metadata';
import { BridgeQuotaService, type QuotaCount } from './quota.service';

/** Requests already handled: the decorators may register this interceptor more than once. */
const handled = new WeakSet<object>();

interface HttpLikeResponse {
  statusCode?: number;
  // Express / Node
  setHeader?: (name: string, value: string) => unknown;
  getHeader?: (name: string) => unknown;
  // Fastify reply
  header?: (name: string, value: string) => unknown;
}

/**
 * Outside production, a response from an endpoint that counts a metric says
 * so, so the browser SDK can warn in development when the page also reports
 * that metric (the same action counted twice). Never sent when
 * `NODE_ENV=production`.
 */
export const USAGE_COUNTED_HEADER = 'X-Bridge-Usage-Counted';

/** How often a confirm is asked before the unit is counted another way: Bridge counts a confirm once, so asking again is safe. */
const CONFIRM_ATTEMPTS = 3;

@Injectable()
export class BridgeQuotaInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Bridge');

  constructor(
    private readonly reflector: Reflector,
    private readonly quota: BridgeQuotaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const { request, response } = this.extract(context);
    if (!request || handled.has(request)) return next.handle();
    handled.add(request);

    const entitlement = this.reflector.getAllAndOverride<string | undefined>(REQUIRED_ENTITLEMENT_KEY, [context.getHandler(), context.getClass()]);
    const required = this.reflector.get<QuotaMetadata | undefined>(REQUIRED_QUOTA_KEY, context.getHandler());
    const sync = this.reflector.get<QuotaMetadata | undefined>(SYNC_QUOTA_KEY, context.getHandler());
    if (!entitlement && !required && !sync) return next.handle();

    const before = async (): Promise<UsageHold | null> => {
      if (entitlement) await this.quota.assertEntitlement(request, entitlement);
      // This endpoint is where these metrics are counted. Marked before the hold, so a 402 carries it too.
      this.markCounted(response, [required?.metric, sync?.metric].filter((metric): metric is string => metric !== undefined));
      if (!required) return null;
      // A new hold for every request: the client's Idempotency-Key is never what a unit is held or counted for.
      return this.quota.hold(request, required.metric);
    };

    // Once: the unit is confirmed, or given back, and the gauges are set.
    let settled = false;
    const settle = async (held: UsageHold | null, ok: boolean): Promise<void> => {
      if (settled) return;
      settled = true;
      if (held !== null) await (ok ? this.confirm(request, held, required?.current === undefined) : this.giveBack(held));
      if (!ok) return;
      const writes: Promise<void>[] = [];
      if (required?.current) writes.push(this.quota.sync(request, required.metric, this.counter(required, context, request)!));
      if (sync && !(required?.current && required.metric === sync.metric)) {
        writes.push(this.quota.sync(request, sync.metric, this.counter(sync, context, request)!));
      }
      await Promise.all(writes);
    };

    return from(before()).pipe(
      switchMap((held) =>
        next.handle().pipe(
          concatMap(async (value) => {
            await settle(held, this.succeeded(response));
            return value;
          }),
          catchError((error: unknown) => from(settle(held, false)).pipe(concatMap(() => throwError(() => error)))),
          // The caller went away before the handler answered: the unit was never used.
          finalize(() => void settle(held, false)),
        ),
      ),
    );
  }

  /**
   * The work happened: the unit counts. Never fails the response: the work is
   * done, and failing it would only invite a retry that does it twice.
   * Bridge counts a confirm once, so it is asked again when Bridge did not
   * answer. When the hold is gone (the handler outlasted it, so the unit was
   * free for another request) or Bridge never answers, a counter is reported
   * instead, under a one-time id of the hold: the work is still counted, once,
   * and the next request at the limit is refused.
   */
  private async confirm(request: object, held: UsageHold, counter: boolean): Promise<void> {
    for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt++) {
      try {
        await held.confirm();
        return;
      } catch (error) {
        if (this.isGone(error)) {
          this.logger.warn(`The unit held for "${held.metric}" was no longer held when the handler finished (after ${String(held.expiresInSeconds)} s); it is counted from a report instead.`);
          break;
        }
        if (attempt === CONFIRM_ATTEMPTS) {
          this.logger.error(`Could not confirm "${held.metric}" after the request; it is counted from a report instead: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (counter) await this.quota.countUnconfirmed(request, held);
  }

  /** The work did not happen: the unit goes back. Never fails the response. */
  private async giveBack(held: UsageHold): Promise<void> {
    try {
      await held.giveBack();
    } catch (error) {
      this.logger.warn(`Could not give back the unit held for "${held.metric}"; Bridge gives it back itself in ${String(held.expiresInSeconds)} s: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private isGone(error: unknown): boolean {
    return typeof error === 'object' && error !== null && ((error as { status?: unknown }).status === 404 || (error as { kind?: unknown }).kind === 'not-found');
  }

  /** Nest set the final status before interceptors ran; the handler may have changed it. */
  private succeeded(response: HttpLikeResponse | undefined): boolean {
    const status = response?.statusCode;
    if (typeof status !== 'number') return true; // non-HTTP context: success = no throw
    return status >= 200 && status < 300;
  }

  /** The count function bound to this workspace and the controller instance. */
  private counter(meta: QuotaMetadata, context: ExecutionContext, request: object): QuotaCount | undefined {
    if (!meta.current) return undefined;
    const current = meta.current;
    return () => current(this.quotaTenant(request), this.controller(context));
  }

  private quotaTenant(request: object): QuotaTenant {
    const actor = this.quota.actorFor(request);
    return { id: actor.workspaceId ?? '', userId: actor.personId ?? '', actor, request };
  }

  private controller(context: ExecutionContext): unknown {
    try {
      return this.moduleRef.get(context.getClass(), { strict: false });
    } catch {
      return undefined;
    }
  }

  /**
   * Name the metrics this endpoint counts on the response, outside production
   * only, and expose the header to cross-origin pages. Best effort: never
   * fails the request.
   */
  private markCounted(response: HttpLikeResponse | undefined, metrics: string[]): void {
    if (!response || metrics.length === 0 || process.env.NODE_ENV === 'production') return;
    try {
      const set = (name: string, value: string) => {
        if (typeof response.setHeader === 'function') response.setHeader(name, value);
        else if (typeof response.header === 'function') response.header(name, value);
      };
      const current = (name: string): string => {
        const raw = typeof response.getHeader === 'function' ? response.getHeader(name) : undefined;
        return Array.isArray(raw) ? raw.join(', ') : typeof raw === 'string' ? raw : '';
      };
      const merge = (existing: string, add: string[]) =>
        [...new Set([...existing.split(',').map((value) => value.trim()).filter(Boolean), ...add])].join(', ');
      set(USAGE_COUNTED_HEADER, merge(current(USAGE_COUNTED_HEADER), [...new Set(metrics)]));
      set('Access-Control-Expose-Headers', merge(current('Access-Control-Expose-Headers'), [USAGE_COUNTED_HEADER]));
    } catch {
      /* a development hint never breaks the request */
    }
  }

  private extract(context: ExecutionContext): { request?: object; response?: HttpLikeResponse } {
    if (context.getType<string>() === 'graphql') {
      const gql = context.getArgByIndex(2) as { req?: object } | undefined;
      return { request: gql?.req ?? gql };
    }
    const http = context.switchToHttp();
    return { request: http.getRequest<object>(), response: http.getResponse<HttpLikeResponse>() };
  }
}
