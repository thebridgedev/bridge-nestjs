// TBP-341 — DI tokens + module options for the unified BridgeService.

/** Injection token for the resolved BridgeModule options. */
export const BRIDGE_OPTIONS = Symbol('BRIDGE_OPTIONS');

export interface BridgeModuleOptions {
  /** Bridge API base URL (e.g. https://api.thebridge.dev). */
  apiBaseUrl: string;
  /** App id (sent as `x-app-id` header). */
  appId: string;
  /**
   * Pull-cache TTL in milliseconds. Snapshot fetches for a given tenant are
   * deduped + cached for this long. Defaults to 30s — long enough to amortize
   * across a request burst, short enough that plan/entitlement changes show
   * up promptly in long-lived NestJS processes.
   */
  ttlMs?: number;
}
