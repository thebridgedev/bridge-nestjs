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
  Logger,
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
const logger = new Logger('Bridge');

/** Entitlement keys the TBP-705 development note was already logged for. */
const notedEntitlements = new Set<string>();

/**
 * TBP-705 — `@RequireEntitlement` is the documented exception to "every gate
 * is a flag". Outside production, say so once per key, the first time a
 * handler carrying it is evaluated.
 */
export function noteDirectEntitlementCheck(key: string): void {
  if (process.env.NODE_ENV === 'production' || notedEntitlements.has(key)) return;
  notedEntitlements.add(key);
  logger.warn(
    `[bridge] @RequireEntitlement('${key}') checks the plan directly. The standard is @RequireFeatureFlag with a rule on bridge:billing.entitlement.${key} — see "npx @nebulr-group/bridge-cli check gates".`,
  );
}

/** Test hook: forget which keys were noted. */
export function resetEntitlementNotes(): void {
  notedEntitlements.clear();
}

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
 * TBP-697 — outside production, a response from an endpoint that counts a
 * metric says so, so the browser plugin can warn in development when the page
 * ALSO reports that metric with `bridge.usage` (the same action counted
 * twice). Never sent when `NODE_ENV=production`.
 */
export const USAGE_COUNTED_HEADER = 'X-Bridge-Usage-Counted';

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
    if (entitlement) noteDirectEntitlementCheck(entitlement);

    const before = async (): Promise<{ recordCounter: boolean }> => {
      if (entitlement) await this.quota.assertEntitlement(request, entitlement);
      // TBP-697 — this endpoint is where these metrics are counted. Marked
      // before the check so a 402 refusal carries it too.
      const counted = [required?.metric, sync?.metric].filter((m): m is string => !!m);
      if (!required) {
        this.markCounted(response, counted);
        return { recordCounter: false };
      }
      let decision;
      try {
        decision = await this.quota.assertQuota(request, required.metric, {
          current: this.counter(required, context, request),
        });
      } catch (error) {
        this.markCounted(response, counted);
        throw error;
      }
      // A gauge nobody counts here (e.g. seats, which Bridge keeps from
      // membership) is checked but never reported as a counter event.
      const recordCounter = !required.current && decision.quota?.kind !== 'gauge';
      const checkedOnly = !required.current && !recordCounter;
      this.markCounted(response, checkedOnly ? counted.filter((m) => m !== required.metric) : counted);
      return { recordCounter };
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

  /**
   * TBP-697 — name the metrics this endpoint counts on the response, outside
   * production only. Also exposed to cross-origin pages (`fetch` cannot read
   * a custom header otherwise). Best effort: never fails the request.
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
        [...new Set([...existing.split(',').map((v) => v.trim()).filter(Boolean), ...add])].join(', ');
      set(USAGE_COUNTED_HEADER, merge(current(USAGE_COUNTED_HEADER), [...new Set(metrics)]));
      set('Access-Control-Expose-Headers', merge(current('Access-Control-Expose-Headers'), [USAGE_COUNTED_HEADER]));
    } catch {
      /* a dev hint must never break the request */
    }
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
