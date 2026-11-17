// A plan limit is one decorator on the handler that creates the thing.

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
 * `metric`, and count it once the handler answered 2xx.
 *
 * Bridge holds one unit before the handler runs, so two requests never get
 * the last one. The unit counts when the handler answers 2xx and goes back
 * when it fails or answers otherwise. A `metered` limit never refuses; the
 * overage is billed.
 *
 * - Counter (no `current`): the held unit is the count. Every request holds
 *   its own unit; a retry is a new request and counts again.
 * - Gauge (`current`): after a 2xx the gauge is set to your count.
 *
 * Needs a user verified by `BridgeAuthGuard` and the module's `appKey`. If
 * Bridge cannot be reached the request is refused with 503.
 *
 * @example
 * ```ts
 * @Post()
 * @RequireQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
 * create() {}
 *
 * // Who may export is a flag; how many is the quota.
 * @Post(':id/export')
 * @RequireFlag('exports-enabled')
 * @RequireQuota('exports')
 * export() {}
 * ```
 */
export function RequireQuota<C = any>(metric: string, opts: RequireQuotaOptions<C> = {}): MethodDecorator {
  assertMetric(metric, 'RequireQuota');
  const meta: QuotaMetadata = { metric, current: opts.current };
  return applyDecorators(SetMetadata(REQUIRED_QUOTA_KEY, meta), UseInterceptors(BridgeQuotaInterceptor)) as MethodDecorator;
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
  return applyDecorators(SetMetadata(SYNC_QUOTA_KEY, meta), UseInterceptors(BridgeQuotaInterceptor)) as MethodDecorator;
}

/**
 * Refuse the request with 403 `ENTITLEMENT_REQUIRED` unless the workspace's
 * plan includes `key`. Checked before `@RequireQuota`, on a user verified by
 * `BridgeAuthGuard`. Works on a handler or a whole controller.
 *
 * It asks the flag `bridge:billing.entitlement.<key>`, the same flag
 * `@RequireFlag` can gate on, so the plan is never read directly. Prefer
 * `@RequireFlag('<flag>')` with the flag's rule on that entitlement when you
 * want a 402 `FEATURE_NOT_IN_PLAN` and the rule to say why.
 */
export function RequireEntitlement(key: string): MethodDecorator & ClassDecorator {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('[bridge-nestjs] @RequireEntitlement needs an entitlement key');
  }
  return applyDecorators(SetMetadata(REQUIRED_ENTITLEMENT_KEY, key), UseInterceptors(BridgeQuotaInterceptor));
}

function assertMetric(metric: string, name: string): void {
  if (typeof metric !== 'string' || metric.length === 0) {
    throw new TypeError(`[bridge-nestjs] @${name} needs a metric name`);
  }
}
