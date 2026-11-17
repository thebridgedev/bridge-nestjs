// Metadata keys and option types shared by the quota decorators and their
// interceptor (kept apart so neither imports the other).

import type { Actor } from '@nebulr-group/bridge-auth-core/server';

export const REQUIRED_QUOTA_KEY = 'bridge:requiredQuota';
export const SYNC_QUOTA_KEY = 'bridge:syncQuota';
export const REQUIRED_ENTITLEMENT_KEY = 'bridge:requiredEntitlement';

/** The workspace a `current` count is asked about. From the verified token only. */
export interface QuotaTenant {
  /** Verified workspace id. */
  id: string;
  /** Verified person id ('' for a key). */
  userId: string;
  /** The verified caller. */
  actor: Actor;
  /** The incoming request. */
  request: unknown;
}

/**
 * Counts how many exist right now for this workspace. Gets the controller
 * instance as its second argument, so it can reach the controller's injected
 * services:
 *
 *   current: (t, self: TicketsController) => self.tickets.countFor(t.id)
 */
export type QuotaCounter<C = any> = (tenant: QuotaTenant, controller: C) => number | Promise<number>;

export interface RequireQuotaOptions<C = any> {
  /**
   * Gauge mode: for things that exist and free room when deleted. Return
   * your own count; after a 2xx the gauge is set to the new count.
   *
   * Leave out for a counter: something that happened (an export, an API
   * call). One is counted after a 2xx, and the request's `Idempotency-Key`
   * header, when it sends one, makes a retry hold the same unit.
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
