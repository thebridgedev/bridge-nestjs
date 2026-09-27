// TBP-704 — metadata keys and option types shared by the quota decorators
// and their interceptor (kept apart so neither imports the other).

import type { TenantScope } from '../bridge/tenant-scope';

export const REQUIRED_QUOTA_KEY = 'bridge:requiredQuota';
export const SYNC_QUOTA_KEY = 'bridge:syncQuota';
export const REQUIRED_ENTITLEMENT_KEY = 'bridge:requiredEntitlement';

/** The tenant a `current` count is asked about. From the verified token only. */
export interface QuotaTenant {
  /** Verified tenant (workspace) id. */
  id: string;
  /** Verified user id. */
  userId: string;
  /** The full tenant view — subscription, entitlements, usage. */
  scope: TenantScope;
  /** The incoming request. */
  request: unknown;
}

/**
 * Counts how many exist right now for this tenant. Gets the controller
 * instance as its second argument, so it can reach the controller's injected
 * services:
 *
 *   current: (t, self: TicketsController) => self.tickets.countFor(t.id)
 */
export type QuotaCounter<C = any> = (tenant: QuotaTenant, controller: C) => number | Promise<number>;

export interface RequireQuotaOptions<C = any> {
  /**
   * Gauge mode — for things that exist and free room when deleted. Return
   * your own count; the request is refused when it is already at the limit,
   * and after a 2xx the gauge is set to the new count.
   *
   * Leave out for a counter — something that happened (an export, an API
   * call): Bridge's tally is compared, and one event is reported after a 2xx,
   * deduplicated by the request's `Idempotency-Key` header.
   */
  current?: QuotaCounter<C>;
}

export interface SyncQuotaOptions<C = any> {
  /** Your count after the handler ran; the gauge is set to it after a 2xx. */
  current: QuotaCounter<C>;
}

export interface QuotaMetadata {
  metric: string;
  current?: QuotaCounter;
}

