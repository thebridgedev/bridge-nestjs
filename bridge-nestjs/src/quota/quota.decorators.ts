// TBP-704 — a plan limit is one decorator on the handler that creates the thing.

import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';

import { BridgeQuotaInterceptor } from './quota.interceptor';
import {
  REQUIRED_ENTITLEMENT_KEY,
  REQUIRED_QUOTA_KEY,
  SYNC_QUOTA_KEY,
  type QuotaMetadata,
  type RequireQuotaOptions,
  type SyncQuotaOptions,
} from './quota.metadata';

export {
  REQUIRED_QUOTA_KEY,
  SYNC_QUOTA_KEY,
  REQUIRED_ENTITLEMENT_KEY,
  type QuotaTenant,
  type QuotaCounter,
  type RequireQuotaOptions,
  type SyncQuotaOptions,
  type QuotaMetadata,
} from './quota.metadata';

/**
 * Refuse the request with 402 `QUOTA_EXCEEDED` at the plan's limit for
 * `metric`, and record usage once the handler answered 2xx.
 *
 * - Counter (no `current`): compares Bridge's count; reports 1 event after a
 *   2xx, keyed by the `Idempotency-Key` header when the request sends one.
 * - Gauge (`current`): compares your count; sets the gauge after a 2xx.
 *
 * A `metered` quota never refuses. Nothing is recorded for a refused, failed
 * (4xx/5xx) or thrown request. Needs a user verified by `BridgeAuthGuard`.
 *
 * @example
 * ```ts
 * @Post()
 * @RequireQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
 * create() {}
 *
 * @Post(':id/export')
 * @RequireEntitlement('exports')
 * @RequireQuota('exports')
 * export() {}
 * ```
 */
export function RequireQuota<C = any>(metric: string, opts: RequireQuotaOptions<C> = {}): MethodDecorator {
  assertMetric(metric, 'RequireQuota');
  const meta: QuotaMetadata = { metric, current: opts.current };
  return applyDecorators(
    SetMetadata(REQUIRED_QUOTA_KEY, meta),
    UseInterceptors(BridgeQuotaInterceptor),
  ) as MethodDecorator;
}

/**
 * Keep a gauge in step without checking the limit: after a 2xx, set
 * `metric` to your current count. For deletes and bulk operations.
 *
 * @example
 * ```ts
 * @Delete(':id')
 * @SyncQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
 * remove() {}
 * ```
 */
export function SyncQuota<C = any>(metric: string, opts: SyncQuotaOptions<C>): MethodDecorator {
  assertMetric(metric, 'SyncQuota');
  if (typeof opts?.current !== 'function') {
    throw new TypeError(`[bridge-nestjs] @SyncQuota('${metric}') needs a \`current\` count function`);
  }
  const meta: QuotaMetadata = { metric, current: opts.current };
  return applyDecorators(
    SetMetadata(SYNC_QUOTA_KEY, meta),
    UseInterceptors(BridgeQuotaInterceptor),
  ) as MethodDecorator;
}

/**
 * Refuse the request with 403 `ENTITLEMENT_REQUIRED` unless the tenant's
 * plan includes `key`. Checked before `@RequireQuota`, on a user verified by
 * `BridgeAuthGuard`. Works on a handler or a whole controller.
 */
export function RequireEntitlement(key: string): MethodDecorator & ClassDecorator {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('[bridge-nestjs] @RequireEntitlement needs an entitlement key');
  }
  return applyDecorators(
    SetMetadata(REQUIRED_ENTITLEMENT_KEY, key),
    UseInterceptors(BridgeQuotaInterceptor),
  );
}

function assertMetric(metric: string, name: string): void {
  if (typeof metric !== 'string' || metric.length === 0) {
    throw new TypeError(`[bridge-nestjs] @${name} needs a metric name`);
  }
}
