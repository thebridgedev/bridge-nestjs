// bridge-nestjs/flags — DI-injectable wrapper around BridgeFlags (TBP-200).
//
// `BridgeFlags` is the auth-core SDK class; this thin Nest service wraps it
// so guards/interceptors/controllers can inject `BridgeFlagsService` and
// test mocks are easy (just `provide: BridgeFlagsService, useValue: ...`).
//
// Backend mode is the default — server-side flag eval refuses to bucket
// rolled-out rules without an explicit identity (per the locked decision
// in TBP-170). Pass `mode: 'frontend'` in `BridgeFlagsModule.forRoot` if
// you really want frontend semantics on the server.

import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  BridgeFlags,
  type BridgeFlagsMode,
  type BridgeFlagsHooks,
  type CachedFlag,
  type EvalContext,
} from '@nebulr-group/bridge-auth-core';

import { BRIDGE_FLAGS_OPTIONS, BRIDGE_FLAGS, type BridgeFlagsModuleOptions } from './flags.tokens';

@Injectable()
export class BridgeFlagsService implements OnModuleDestroy {
  private telemetryStop?: () => Promise<void>;

  constructor(
    @Inject(BRIDGE_FLAGS) public readonly bridge: BridgeFlags,
    @Inject(BRIDGE_FLAGS_OPTIONS) private readonly options: BridgeFlagsModuleOptions,
  ) {
    if (options.onTelemetryStop) {
      this.telemetryStop = options.onTelemetryStop;
    }
  }

  /** Backend or frontend. Defaults to backend in the Nest module. */
  get mode(): BridgeFlagsMode {
    return this.bridge.getMode();
  }

  /**
   * Read a flag value. TS infers `T` from `defaultValue`. Pass `context`
   * for per-call overrides (e.g. impersonation, identity from a header).
   *
   * auth-core's `bridge.flag()` returns `FlagEvalResult<T> = { passed, value }`
   * as of 0.4.0-beta.10; this wrapper extracts `.value` to preserve the
   * historical "returns T" contract that guards/decorators rely on.
   */
  flag<T>(key: string, defaultValue: T, context?: Partial<EvalContext>): T {
    return this.bridge.flag<T>(key, defaultValue, context).value;
  }

  /** Replace the global eval context (e.g. on startup). */
  setContext(ctx: EvalContext, merge = false): void {
    this.bridge.setContext(ctx, merge);
  }

  /** Bulk-load cached flags from bridge-api. */
  hydrate(flags: CachedFlag[]): void {
    this.bridge.hydrate(flags);
  }

  /** Register extra hooks alongside the ones the module sets up. */
  setHooks(hooks: BridgeFlagsHooks): void {
    this.bridge.setHooks(hooks);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.telemetryStop) {
      try {
        await this.telemetryStop();
      } catch {
        // teardown errors swallowed; logs would be more useful but we
        // can't reach the Nest logger without extra plumbing.
      }
    }
  }
}
