// TBP-341 — Tenant-scoped view onto the unified bridge surface.
//
// One TenantScope per incoming request (or per arbitrary tenantId for cron /
// admin paths once that path lands). All slices share one cached snapshot
// fetch — `GET /session/init` returns subscription + entitlements + branding
// + user in a single round-trip, and BridgePullCache dedups concurrent calls.

import { BridgePullCache } from '@nebulr-group/bridge-auth-core';

export interface BrandingSnapshot {
  logo: string;
  name: string;
  primaryButtonBgColor?: string;
  textColor?: string;
  bgColor?: string;
  fontFamily?: string;
}

export interface SubscriptionSnapshot {
  plan: { slug: string; name: string };
  status: string;
  endsAt?: string;
  gateEngaged?: boolean;
}

export interface UserSnapshot {
  id: string;
  email?: string;
  role: string;
  tenantId: string;
}

export interface SessionSnapshotData {
  app: { branding: BrandingSnapshot };
  tenant: {
    id: string;
    name: string;
    subscription: SubscriptionSnapshot;
    entitlements: Record<string, boolean>;
  };
  user: UserSnapshot;
}

export interface TenantEntitlementsView {
  /** Synchronous check after the snapshot is loaded. Caller must `await tenant.snapshot` first. */
  canSync(key: string, cached: Record<string, boolean> | undefined): boolean;
  /** Loads the snapshot if needed, then answers the entitlement check. */
  can(key: string): Promise<boolean>;
  /** The full entitlements map; fetches the snapshot on first call. */
  snapshot(): Promise<Record<string, boolean>>;
}

/**
 * TBP-275 — per-metric usage quota snapshot, mirroring the bridge-api
 * `GET /usage/quota/:metric` shape. For `metered` quotas the overage fields are
 * populated so a server can show / log live cost.
 */
export interface QuotaSnapshot {
  metric: string;
  used: number;
  limit: number;
  remaining: number;
  warningLevel: null | 'approaching' | 'critical';
  policy: 'hard' | 'metered';
  /** Per-unit price (metered only). */
  unitAmount?: number;
  currency?: string;
  /** Estimated overage cost this period (metered only). */
  overageEstimate?: number;
  /** True once usage passed the included allotment (metered only). */
  overcap?: boolean;
}

/**
 * TBP-275 — usage slice on a {@link TenantScope}. `report` ingests a usage event
 * (server-side; idempotency-keyed) and `quota` reads the live per-metric snapshot
 * including metered overage estimate.
 */
export interface TenantUsageView {
  /**
   * Report `value` units of `metric` for this tenant. Best-effort: resolves when
   * the POST completes and swallows transport errors (never throws into the
   * request path). `idempotencyKey` auto-generates when omitted so accidental
   * double-reports dedupe server-side.
   */
  report(metric: string, value?: number, idempotencyKey?: string): Promise<void>;
  /** Live quota snapshot for a metric (or null when no quota is configured). */
  quota(metric: string): Promise<QuotaSnapshot | null>;
}

export class TenantScope {
  constructor(
    private readonly userJwt: string,
    private readonly cacheKey: string,
    private readonly cache: BridgePullCache,
    private readonly apiBaseUrl: string,
    private readonly appId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /**
   * Load the session.snapshot payload for this tenant. Cached via
   * `BridgePullCache`; concurrent callers share the in-flight fetch.
   */
  snapshot(): Promise<SessionSnapshotData> {
    return this.cache.get(`session:${this.cacheKey}`, () => this._fetchSnapshot());
  }

  /** Lazy: the subscription slice of the session snapshot. */
  get subscription(): Promise<SubscriptionSnapshot> {
    return this.snapshot().then((s) => s.tenant.subscription);
  }

  /** Lazy: app branding (logo, colors, name). */
  get branding(): Promise<BrandingSnapshot> {
    return this.snapshot().then((s) => s.app.branding);
  }

  /** Lazy: the user snapshot for the JWT subject (id/email/role/tenantId). */
  get user(): Promise<UserSnapshot> {
    return this.snapshot().then((s) => s.user);
  }

  /** Lazy: the entitlements map; `.can(key)` is the common path. */
  get entitlements(): TenantEntitlementsView {
    const snap = (): Promise<Record<string, boolean>> =>
      this.snapshot().then((s) => s.tenant.entitlements);
    return {
      canSync: (key, cached) => !!cached?.[key],
      can: async (key) => {
        const m = await snap();
        return !!m[key];
      },
      snapshot: snap,
    };
  }

  /** Lazy: the usage slice — `report(metric)` + `quota(metric)`. */
  get usage(): TenantUsageView {
    return {
      report: (metric, value = 1, idempotencyKey?) =>
        this._reportUsage(metric, value, idempotencyKey),
      quota: (metric) => this._fetchQuota(metric),
    };
  }

  /** Force-refresh the cached snapshot on the next access (post-mutation). */
  invalidate(): void {
    this.cache.invalidate(`session:${this.cacheKey}`);
  }

  private async _reportUsage(
    metric: string,
    value: number,
    idempotencyKey?: string,
  ): Promise<void> {
    if (typeof metric !== 'string' || metric.length === 0) return;
    const url = `${this.apiBaseUrl.replace(/\/+$/, '')}/usage/ingest`;
    const key =
      idempotencyKey ??
      (typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${this.cacheKey}:${metric}:${value}`);
    try {
      await this.fetcher(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.userJwt}`,
          'x-app-id': this.appId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ metric, value, idempotencyKey: key }),
      });
    } catch {
      // Best-effort — usage reporting must never break the request path.
    }
  }

  private async _fetchQuota(metric: string): Promise<QuotaSnapshot | null> {
    const url = `${this.apiBaseUrl.replace(/\/+$/, '')}/usage/quota/${encodeURIComponent(metric)}`;
    const res = await this.fetcher(url, {
      headers: {
        Authorization: `Bearer ${this.userJwt}`,
        'x-app-id': this.appId,
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`[bridge-nestjs] GET /usage/quota/${metric} failed: ${res.status}`);
    }
    return (await res.json()) as QuotaSnapshot | null;
  }

  private async _fetchSnapshot(): Promise<SessionSnapshotData> {
    const url = `${this.apiBaseUrl.replace(/\/+$/, '')}/session/init`;
    const res = await this.fetcher(url, {
      headers: {
        Authorization: `Bearer ${this.userJwt}`,
        'x-app-id': this.appId,
      },
    });
    if (!res.ok) {
      throw new Error(`[bridge-nestjs] GET /session/init failed: ${res.status}`);
    }
    return (await res.json()) as SessionSnapshotData;
  }
}
