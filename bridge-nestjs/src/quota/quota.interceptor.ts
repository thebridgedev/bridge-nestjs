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
}

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
      if (!required) return null;
      const key = this.idempotencyHeader(request);
      return this.quota.hold(request, required.metric, key === undefined ? {} : { idempotencyKey: key });
    };

    // Once: the unit is confirmed, or given back, and the gauges are set.
    let settled = false;
    const settle = async (held: UsageHold | null, ok: boolean): Promise<void> => {
      if (settled) return;
      settled = true;
      if (held !== null) await (ok ? this.confirm(held) : this.giveBack(held));
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

  /** The work happened: the unit counts. Never fails the response. */
  private async confirm(held: UsageHold): Promise<void> {
    try {
      await held.confirm();
    } catch (error) {
      if (this.isGone(error)) {
        // Bridge gives a unit back after 120 seconds: the handler took longer than that.
        this.logger.warn(`The unit held for "${held.metric}" was no longer held when the handler finished (after ${String(held.expiresInSeconds)} s); it was not counted.`);
        return;
      }
      try {
        await held.confirm();
      } catch (again) {
        if (!this.isGone(again)) this.logger.error(`Could not count "${held.metric}" after the request: ${again instanceof Error ? again.message : String(again)}`);
      }
    }
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

  private idempotencyHeader(request: object): string | undefined {
    const headers = (request as { headers?: Record<string, string | string[] | undefined> }).headers;
    const raw = headers?.['idempotency-key'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
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
