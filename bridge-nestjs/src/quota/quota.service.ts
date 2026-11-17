// Plan limits and entitlements as plain service calls.
//
// Everything `@RequireQuota`, `@SyncQuota` and `@RequireEntitlement` do is a
// call on this service, so a developer who wants control (a worker, a bulk
// endpoint, a check in the middle of a handler) calls the same code the
// decorators run.
//
// The model:
//   - the server is authoritative, the client is decorative;
//   - a counter is something that happened (exports, API calls): Bridge
//     counts it, here from the unit a hold confirms;
//   - a gauge is something that exists and frees room when deleted (tickets,
//     projects): the app counts it and sends Bridge the whole current count
//     after every create and delete. No decrement, so it heals itself;
//   - the last unit goes to one request: `hold` takes a unit before the work,
//     and the unit is confirmed once the work happened or given back;
//   - a `metered` limit never refuses, it bills.
//
// Identity only ever comes from the caller BridgeAuthGuard verified on this
// request, never a header and never a raw token.

import { createHash } from 'crypto';
import { Inject, Injectable, ForbiddenException, HttpException, HttpStatus, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import {
  entitlementFlag,
  isBridgeError,
  isLimitReached,
  quotaExceededBody as limitBody,
  type Actor,
  type BridgeServer,
  type QuotaSnapshot,
  type UsageHold,
} from '@nebulr-group/bridge-auth-core/server';

import { BridgeService } from '../bridge.service';
import { BRIDGE_DEFAULTS, BRIDGE_OPTIONS, BRIDGE_SERVER, type BridgeModuleOptions } from '../options';

/** Body of the 402 a request at its plan limit is refused with. */
export interface QuotaExceededBody {
  statusCode: 402;
  code: 'QUOTA_EXCEEDED';
  message: string;
  metric: string;
  used: number;
  limit: number;
  /** Where to upgrade: the module's `manageRoute`, default `/subscription`. */
  fix: string;
}

/** Body of the 403 a request without the entitlement is refused with. */
export interface EntitlementRequiredBody {
  statusCode: 403;
  code: 'ENTITLEMENT_REQUIRED';
  message: string;
  entitlement: string;
  fix: string;
}

/** Body of the 402 a workspace locked for payment is refused with. */
export interface BillingLockedBody {
  statusCode: 402;
  code: 'BILLING_GATE_ENGAGED';
  message: string;
  reason: 'billing_locked';
  billing: { status: string; gateEngaged: true; recoveryUrl: string };
  fix: string;
}

/** 402 Payment Required: Nest has no built-in exception for it. */
export class QuotaExceededException extends HttpException {
  constructor(public readonly body: QuotaExceededBody) {
    super(body, HttpStatus.PAYMENT_REQUIRED);
  }
}

export class EntitlementRequiredException extends ForbiddenException {
  constructor(public readonly body: EntitlementRequiredBody) {
    super(body);
  }
}

/** 402 for a workspace locked for payment: it can be read, not changed, until it pays. */
export class BillingLockedException extends HttpException {
  constructor(public readonly body: BillingLockedBody) {
    super(body, HttpStatus.PAYMENT_REQUIRED);
  }
}

/** A gauge's current count: a number, or a function that counts. */
export type QuotaCount = number | (() => number | Promise<number>);

export interface QuotaCheckOptions {
  /**
   * Gauge mode: how many exist right now in this workspace (your own count).
   * Compared with the limit instead of Bridge's stored level. Leave out to
   * compare what Bridge has.
   */
  current?: QuotaCount;
}

export interface QuotaDecision {
  /** False only for a `hard` quota at or past its limit. */
  allowed: boolean;
  metric: string;
  /** The count compared against the limit (your count in gauge mode). */
  used: number;
  /** `null` when the plan sets no quota for this metric (unlimited). */
  limit: number | null;
  /** The live snapshot, `null` when no quota is configured. */
  quota: QuotaSnapshot | null;
}

export interface QuotaHoldOptions {
  /** Units to hold. @default 1 */
  quantity?: number;
  /**
   * What the unit is held for: the client's idempotency key (typically its
   * `Idempotency-Key` header). A retry that arrives while the unit is still
   * held reuses it. Scoped to the verified workspace and the metric before it
   * is sent. Leave out to hold a new unit each time.
   */
  idempotencyKey?: string;
}

export interface QuotaRecordOptions {
  /** Gauge mode: the count after the change. Sets the gauge to it. */
  current?: QuotaCount;
  /** Counter mode: units to count. @default 1 */
  value?: number;
  /**
   * Counter mode: the client's idempotency key. The same key for the same
   * workspace and metric counts one event however often the request is
   * retried. Leave out to let every call count.
   */
  idempotencyKey?: string;
}

/** Where a workspace locked for payment is sent to pay, unless Bridge says another. */
const LOCK_FIX = '/subscription';

@Injectable()
export class BridgeQuotaService {
  private readonly logger = new Logger('Bridge');

  constructor(
    private readonly bridge: BridgeService,
    @Inject(BRIDGE_SERVER) private readonly server: BridgeServer,
    @Inject(BRIDGE_OPTIONS) private readonly options: BridgeModuleOptions,
  ) {}

  private get manageRoute(): string {
    return this.options.manageRoute ?? BRIDGE_DEFAULTS.manageRoute;
  }

  /**
   * The caller BridgeAuthGuard verified on this request, acting in a
   * workspace. 401 when there is none: a quota or entitlement belongs to a
   * workspace, and a `@Public()` route, an unguarded route or a credential
   * that names no workspace has nothing to count against.
   */
  actorFor(req: unknown): Actor {
    const actor = typeof req === 'object' && req !== null ? this.bridge.actorOf(req) : null;
    if (actor === null || actor.workspaceId === null) {
      throw new UnauthorizedException({ statusCode: 401, error: 'Unauthorized', message: 'A signed-in workspace user is required' });
    }
    return actor;
  }

  /** The verified workspace id of this request's caller ('' when there is none). */
  tenantIdFor(req: unknown): string {
    const actor = typeof req === 'object' && req !== null ? this.bridge.actorOf(req) : null;
    return actor?.workspaceId ?? '';
  }

  /**
   * Decide whether one more `metric` fits the plan, without holding anything
   * and without refusing. A `metered` quota and a metric with no quota are
   * always allowed. Rejects with 503 when the quota cannot be read (fail closed).
   */
  async check(req: unknown, metric: string, opts: QuotaCheckOptions = {}): Promise<QuotaDecision> {
    const actor = this.actorFor(req);
    let quota: QuotaSnapshot | null;
    try {
      quota = await this.server.usage.quota(actor, metric);
    } catch (error) {
      throw this.unavailable(metric, error);
    }
    if (quota === null) return { allowed: true, metric, used: 0, limit: null, quota: null };
    if (quota.policy !== 'hard') return { allowed: true, metric, used: quota.used, limit: quota.limit, quota };
    const used = opts.current !== undefined ? await this.count(opts.current, metric) : quota.used;
    return { allowed: used < quota.limit, metric, used, limit: quota.limit, quota };
  }

  /**
   * Refuse with 402 `QUOTA_EXCEEDED` when one more `metric` does not fit a
   * `hard` quota. Resolves with the decision otherwise. Holds nothing: use
   * `hold` when two requests must not both get the last unit.
   */
  async assertQuota(req: unknown, metric: string, opts: QuotaCheckOptions = {}): Promise<QuotaDecision> {
    const decision = await this.check(req, metric, opts);
    if (!decision.allowed) {
      this.logger.log(`Quota check failed: ${metric} ${String(decision.used)}/${String(decision.limit)}`);
      throw new QuotaExceededException(this.quotaExceededBody(metric, decision.used, decision.limit!));
    }
    return decision;
  }

  /**
   * Hold one unit of `metric` for the work about to happen. Confirm the hold
   * when it happened and give it back when it did not; Bridge gives it back
   * itself after 120 seconds.
   *
   * Refuses with 402 `QUOTA_EXCEEDED` when a `hard` limit has nothing left, with
   * 402 `BILLING_GATE_ENGAGED` when the workspace is locked for payment, and
   * with 503 `QUOTA_UNAVAILABLE` when Bridge cannot say (fail closed).
   */
  async hold(req: unknown, metric: string, opts: QuotaHoldOptions = {}): Promise<UsageHold> {
    const actor = this.actorFor(req);
    try {
      return await this.server.usage.hold(actor, metric, {
        ...(opts.quantity === undefined ? {} : { quantity: opts.quantity }),
        ...(opts.idempotencyKey === undefined ? {} : { decision: this.idempotencyKeyFor(req, metric, opts.idempotencyKey) }),
      });
    } catch (error) {
      if (isLimitReached(error)) {
        this.logger.log(`Quota check failed: ${metric} ${String(error.quota.used)}/${String(error.quota.limit)}`);
        throw new QuotaExceededException({ ...limitBody(error, this.manageRoute) });
      }
      const locked = this.lockedFrom(error);
      if (locked !== null) throw locked;
      throw this.unavailable(metric, error);
    }
  }

  /**
   * Record usage after a successful change, with no hold: the counter gets
   * `value` (default 1) under the idempotency key, the gauge is set to
   * `current`.
   *
   * Never throws: the thing was already created or deleted, and failing the
   * response would invite a retry that creates it twice. A lost gauge write
   * is corrected by the next create or delete.
   */
  async record(req: unknown, metric: string, opts: QuotaRecordOptions = {}): Promise<void> {
    let actor: Actor;
    try {
      actor = this.actorFor(req);
    } catch {
      this.logger.warn(`Usage not recorded for "${metric}": no verified workspace user on this request`);
      return;
    }
    try {
      if (opts.current !== undefined) {
        this.server.usage.set(actor, metric, await this.count(opts.current, metric));
        return;
      }
      const key = opts.idempotencyKey !== undefined ? this.idempotencyKeyFor(req, metric, opts.idempotencyKey) : undefined;
      this.server.usage.count(actor, metric, opts.value ?? 1, key === undefined ? {} : { id: key });
    } catch (error) {
      this.logger.warn(`Could not record "${metric}" after the request: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Set a gauge to the current count: the `@SyncQuota` call. Never throws. */
  async sync(req: unknown, metric: string, current: QuotaCount): Promise<void> {
    await this.record(req, metric, { current });
  }

  /**
   * Refuse with 403 `ENTITLEMENT_REQUIRED` unless the workspace holds `key`,
   * asked as the flag `bridge:billing.entitlement.<key>`. 503 when flags
   * cannot be read (fail closed).
   */
  async assertEntitlement(req: unknown, key: string): Promise<void> {
    this.actorFor(req);
    let granted: boolean;
    try {
      granted = await this.bridge.enabled(req as Parameters<BridgeService['enabled']>[0], entitlementFlag(key));
    } catch (error) {
      this.logger.warn(`Entitlements could not be read, refusing (fail-closed): ${error instanceof Error ? error.message : String(error)}`);
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'ENTITLEMENT_UNAVAILABLE',
        message: `The '${key}' entitlement could not be checked. Try again.`,
        entitlement: key,
      });
    }
    if (!granted) {
      this.logger.log(`Entitlement check failed: ${key}`);
      throw new EntitlementRequiredException({
        statusCode: 403,
        code: 'ENTITLEMENT_REQUIRED',
        message: `Your plan does not include '${key}'.`,
        entitlement: key,
        fix: this.manageRoute,
      });
    }
  }

  quotaExceededBody(metric: string, used: number, limit: number): QuotaExceededBody {
    return { ...limitBody({ metric, used, limit }, this.manageRoute) };
  }

  /*
   * The key sent to Bridge for a client-supplied idempotency key. Bridge
   * dedupes on the key alone, so the client's raw value is never sent: two
   * workspaces (or two metrics) that happen to pick the same key would
   * otherwise swallow each other's events. Scoped to the VERIFIED workspace id
   * and the metric, then hashed so the length is bounded. The same key from
   * the same workspace for the same metric still maps to one.
   */
  idempotencyKeyFor(req: unknown, metric: string, clientKey: string): string {
    const digest = createHash('sha256').update(`${this.tenantIdFor(req)}\u0000${metric}\u0000${clientKey}`).digest('hex');
    return `idem-${digest}`;
  }

  /** A workspace locked for payment, as the 402 body says it; null for any other failure. */
  private lockedFrom(error: unknown): BillingLockedException | null {
    if (!isBridgeError(error) || error.status !== 402 || (error.code !== 'BILLING_GATE_ENGAGED' && error.code !== 'billing-locked')) return null;
    const billing = (error as { payload?: { billing?: { status?: string; recoveryUrl?: string } } }).payload?.billing;
    return new BillingLockedException({
      statusCode: 402,
      code: 'BILLING_GATE_ENGAGED',
      message: 'Billing gate engaged — workspace access is locked',
      reason: 'billing_locked',
      billing: { status: billing?.status ?? 'past_due', gateEngaged: true, recoveryUrl: billing?.recoveryUrl ?? LOCK_FIX },
      fix: this.manageRoute,
    });
  }

  private unavailable(metric: string, error: unknown): ServiceUnavailableException {
    this.logger.warn(`Quota could not be read, refusing (fail-closed) for "${metric}": ${error instanceof Error ? error.message : String(error)}`);
    return new ServiceUnavailableException({
      statusCode: 503,
      code: 'QUOTA_UNAVAILABLE',
      message: `The '${metric}' quota could not be checked. Try again.`,
      metric,
    });
  }

  private async count(current: QuotaCount, metric: string): Promise<number> {
    const value = typeof current === 'function' ? await current() : current;
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`[bridge-nestjs] the count for '${metric}' must be an integer >= 0, got ${String(value)}`);
    }
    return value;
  }
}
