// TBP-704 — the interceptor behind @RequireQuota, @SyncQuota and
// @RequireEntitlement.
//
// An interceptor rather than a guard so it always runs after every guard,
// BridgeAuthGuard included, whatever order the decorators are written in:
// by the time it runs, the request's user token is verified and
// `BridgeService.fromRequest` can answer for it.
//
// Before the handler: entitlement (403), then quota (402).
// After the handler: only when it answered 2xx — one write to Bridge per
// decorated metric. A handler that throws, or that sets a 4xx/5xx status
// itself, records nothing.

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { from, Observable } from 'rxjs';
import { concatMap, switchMap } from 'rxjs/operators';

import { verifiedUserTokenFor } from '../bridge/verified-request';
import {
  REQUIRED_ENTITLEMENT_KEY,
  REQUIRED_QUOTA_KEY,
  SYNC_QUOTA_KEY,
  type QuotaMetadata,
  type QuotaTenant,
} from './quota.metadata';
import { BridgeQuotaService, type QuotaCount } from './quota.service';

/** Requests already handled — the decorators may register this interceptor more than once. */
const handled = new WeakSet<object>();

interface HttpLikeResponse {
  statusCode?: number;
}

@Injectable()
export class BridgeQuotaInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly quota: BridgeQuotaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const { request, response } = this.extract(context);
    if (!request || handled.has(request)) return next.handle();
    handled.add(request);

    const entitlement = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_ENTITLEMENT_KEY,
      [context.getHandler(), context.getClass()],
    );
    const required = this.reflector.get<QuotaMetadata | undefined>(
      REQUIRED_QUOTA_KEY,
      context.getHandler(),
    );
    const sync = this.reflector.get<QuotaMetadata | undefined>(SYNC_QUOTA_KEY, context.getHandler());
    if (!entitlement && !required && !sync) return next.handle();

    const before = async (): Promise<{ recordCounter: boolean }> => {
      if (entitlement) await this.quota.assertEntitlement(request, entitlement);
      if (!required) return { recordCounter: false };
      const decision = await this.quota.assertQuota(request, required.metric, {
        current: this.counter(required, context, request),
      });
      // A gauge nobody counts here (e.g. `users`, which Bridge keeps from
      // membership) is checked but never reported as a counter event.
      return { recordCounter: !required.current && decision.quota?.kind !== 'gauge' };
    };

    const after = async ({ recordCounter }: { recordCounter: boolean }): Promise<void> => {
      if (!this.succeeded(response)) return;
      const writes: Promise<void>[] = [];
      if (required?.current) {
        writes.push(this.quota.sync(request, required.metric, this.counter(required, context, request)!));
      } else if (required && recordCounter) {
        writes.push(
          this.quota.record(request, required.metric, {
            idempotencyKey: this.idempotencyHeader(request),
          }),
        );
      }
      if (sync && !(required?.current && required.metric === sync.metric)) {
        writes.push(this.quota.sync(request, sync.metric, this.counter(sync, context, request)!));
      }
      await Promise.all(writes);
    };

    return from(before()).pipe(
      switchMap((state) => {
        let recorded = false;
        return next.handle().pipe(
          concatMap(async (value) => {
            if (!recorded) {
              recorded = true;
              await after(state);
            }
            return value;
          }),
        );
      }),
    );
  }

  /** Nest set the final status before interceptors ran; the handler may have changed it. */
  private succeeded(response: HttpLikeResponse | undefined): boolean {
    const status = response?.statusCode;
    if (typeof status !== 'number') return true; // non-HTTP context: success = no throw
    return status >= 200 && status < 300;
  }

  /** The count function bound to this tenant and the controller instance. */
  private counter(
    meta: QuotaMetadata,
    context: ExecutionContext,
    request: object,
  ): QuotaCount | undefined {
    if (!meta.current) return undefined;
    const current = meta.current;
    return () => current(this.quotaTenant(request), this.controller(context));
  }

  private quotaTenant(request: object): QuotaTenant {
    const verified = verifiedUserTokenFor(request);
    return {
      id: this.quota.tenantIdFor(request),
      userId: verified?.claims.sub ?? '',
      scope: this.quota.tenantFor(request),
      request,
    };
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
