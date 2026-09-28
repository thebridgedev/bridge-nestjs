// bridge-nestjs/flags — DI tokens + module options (TBP-200).

import type {
  BridgeFlagsHooks,
  BridgeFlagsMode,
  BridgeRuntimeMode,
  EvalContext,
  PullCacheOptions,
  RealtimeClientConfig,
  TelemetryBatcherConfig,
} from '@nebulr-group/bridge-auth-core';

/** Injection token for the raw BridgeFlags instance. Use `BridgeFlagsService` for higher-level access. */
export const BRIDGE_FLAGS = Symbol('BRIDGE_FLAGS');

/** Injection token for the resolved module options. Mostly used inside the module's providers. */
export const BRIDGE_FLAGS_OPTIONS = Symbol('BRIDGE_FLAGS_OPTIONS');

/**
 * Phase 6 (TBP-290/340) — injection token for the pull-mode REST cache.
 * Always registered (consumers may use it even in channel mode for REST
 * routes that aren't channel-mirrored). TTL configured via the
 * `pullCache` option on the module.
 */
export const BRIDGE_PULL_CACHE = Symbol('BRIDGE_PULL_CACHE');

/**
 * TBP-757 — injection token for the source of a request's workspace billing
 * attributes (`bridge:billing.*`). `BridgeModule` binds it to `BridgeService`;
 * with the flags module on its own nothing is bound and flag rules see the
 * verified token's claims only. A token rather than the class so this
 * auth-free entry point never loads the auth half of the SDK.
 */
export const BRIDGE_FLAG_ATTRIBUTE_SOURCE = Symbol('BRIDGE_FLAG_ATTRIBUTE_SOURCE');

/** What `BRIDGE_FLAG_ATTRIBUTE_SOURCE` provides — `BridgeService` implements it. */
export interface FlagAttributeSource {
  /** `bridge:billing.*` attributes for the verified user's workspace; rejects when Bridge is unreachable. */
  billingAttributesFor(req: unknown): Promise<Record<string, unknown>>;
}

export interface BridgeFlagsModuleOptions {
  /** Bridge API base URL. */
  apiBaseUrl: string;
  /** JWT-shaped workspace API key. */
  apiKey: string;
  /**
   * The app whose flags this service evaluates. Optional when `apiKey` is a
   * Bridge API token — its `appId` claim is used. Needed to load the flag
   * rules and to subscribe to the app's live channel.
   */
  appId?: string;
  /**
   * Runtime mode. Defaults to 'backend' — the server-side semantics that
   * refuse to bucket rolled-out rules without an explicit identity.
   */
  mode?: BridgeFlagsMode;
  /**
   * TBP-756 — where a `402 FEATURE_NOT_IN_PLAN` refusal from `@RequireFlag`
   * points to upgrade. Default `/subscription` (the same default as
   * `billing.manageRoute` on `BridgeModule`).
   */
  manageRoute?: string;
  /** Stable server-instance ID, for system-level flags (TBP-172). */
  serverInstanceId?: string;
  /** Initial eval context (e.g. `{ attributes: { region: 'eu' } }`). */
  initialContext?: EvalContext;
  /** Optional realtime opts; set `enabled: false` to skip the websocket subscriber. */
  realtime?: Partial<Omit<RealtimeClientConfig, 'apiBaseUrl' | 'apiKey'>>;
  /** Optional telemetry opts; set `enabled: false` for tests/offline mode. */
  telemetry?: Partial<Omit<TelemetryBatcherConfig, 'apiBaseUrl' | 'apiKey'>>;
  /** Extra hooks chained on top of the built-in telemetry. */
  hooks?: BridgeFlagsHooks;
  /**
   * Phase 6 (TBP-290/340) — runtime profile. Defaults to 'channel' for
   * long-running NestJS services (live WebSocket updates). Use 'pull' for
   * ephemeral runtimes (cron, serverless, webhook handlers, CLI scripts).
   * In 'pull' mode the RealtimeClient is skipped regardless of
   * `realtime.enabled`, and a TTL-bounded REST cache backs reads.
   */
  runtimeMode?: BridgeRuntimeMode;
  /**
   * TTL options (default 30 s). Sets how often the flag rules refresh when no
   * live channel is open — always in 'pull' mode, and in 'channel' mode while
   * the socket is down or the deployment doesn't admit server SDKs — and the
   * TTL of the injectable `BRIDGE_PULL_CACHE`.
   */
  pullCache?: PullCacheOptions;
  /**
   * Internal — set by `forRoot`. Lets the service tear down telemetry on
   * module destroy. Not part of the public API.
   */
  onTelemetryStop?: () => Promise<void>;
}
