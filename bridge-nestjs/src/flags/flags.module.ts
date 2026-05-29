// bridge-nestjs/flags — `BridgeFlagsModule.forRoot(...)` (TBP-200).
//
// Auth-free Nest module for Feature Flags 2.0. Constructs a singleton
// `BridgeFlags` instance wired up with optional realtime + telemetry, and
// exposes it as both the raw token (`BRIDGE_FLAGS`) and the higher-level
// `BridgeFlagsService`.
//
// Usage:
//   imports: [
//     BridgeFlagsModule.forRoot({
//       apiBaseUrl: 'https://api.thebridge.dev',
//       apiKey: process.env.BRIDGE_API_KEY!,
//     }),
//   ],
//
// Guards and decorators are exported by sibling files; import them directly
// (e.g. `import { RequireFlag } from '@nebulr-group/bridge-nestjs/flags'`).

import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import {
  BridgeFlags,
  BridgePullCache,
  RealtimeClient,
  TelemetryBatcher,
  type BridgeFlagsHooks,
} from '@nebulr-group/bridge-auth-core';

import { BridgeContextInterceptor } from './flag.interceptor';
import { BridgeFlagGuard } from './flag.guard';
import { BridgeFlagsService } from './flags.service';
import {
  BRIDGE_FLAGS,
  BRIDGE_FLAGS_OPTIONS,
  BRIDGE_PULL_CACHE,
  type BridgeFlagsModuleOptions,
} from './flags.tokens';

@Global()
@Module({})
export class BridgeFlagsModule {
  /**
   * Configure the module with static options. Returns a DynamicModule that
   * provides BridgeFlags, BridgeFlagsService, BridgeFlagGuard, and
   * BridgeContextInterceptor.
   */
  static forRoot(options: BridgeFlagsModuleOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: BRIDGE_FLAGS_OPTIONS,
      useValue: options,
    };

    const bridgeProvider: Provider = {
      provide: BRIDGE_FLAGS,
      inject: [BRIDGE_FLAGS_OPTIONS],
      useFactory: (opts: BridgeFlagsModuleOptions) => buildBridge(opts),
    };

    // Phase 6 (TBP-290/340) — pull cache provider. Always registered; opts
    // configure the TTL (default 30s). Injectable via `@Inject(BRIDGE_PULL_CACHE)`.
    const pullCacheProvider: Provider = {
      provide: BRIDGE_PULL_CACHE,
      inject: [BRIDGE_FLAGS_OPTIONS],
      useFactory: (opts: BridgeFlagsModuleOptions) =>
        new BridgePullCache(opts.pullCache),
    };

    return {
      module: BridgeFlagsModule,
      providers: [
        optionsProvider,
        bridgeProvider,
        pullCacheProvider,
        BridgeFlagsService,
        BridgeFlagGuard,
        BridgeContextInterceptor,
      ],
      exports: [
        BRIDGE_FLAGS,
        BRIDGE_FLAGS_OPTIONS,
        BRIDGE_PULL_CACHE,
        BridgeFlagsService,
        BridgeFlagGuard,
        BridgeContextInterceptor,
      ],
    };
  }

  /**
   * Async variant — useful when the API key comes from ConfigModule.
   */
  static forRootAsync(asyncOptions: {
    imports?: any[];
    inject?: any[];
    useFactory: (...args: any[]) => Promise<BridgeFlagsModuleOptions> | BridgeFlagsModuleOptions;
  }): DynamicModule {
    const optionsProvider: Provider = {
      provide: BRIDGE_FLAGS_OPTIONS,
      inject: asyncOptions.inject ?? [],
      useFactory: asyncOptions.useFactory,
    };

    const bridgeProvider: Provider = {
      provide: BRIDGE_FLAGS,
      inject: [BRIDGE_FLAGS_OPTIONS],
      useFactory: (opts: BridgeFlagsModuleOptions) => buildBridge(opts),
    };

    const pullCacheProvider: Provider = {
      provide: BRIDGE_PULL_CACHE,
      inject: [BRIDGE_FLAGS_OPTIONS],
      useFactory: (opts: BridgeFlagsModuleOptions) =>
        new BridgePullCache(opts.pullCache),
    };

    return {
      module: BridgeFlagsModule,
      imports: asyncOptions.imports ?? [],
      providers: [
        optionsProvider,
        bridgeProvider,
        pullCacheProvider,
        BridgeFlagsService,
        BridgeFlagGuard,
        BridgeContextInterceptor,
      ],
      exports: [
        BRIDGE_FLAGS,
        BRIDGE_FLAGS_OPTIONS,
        BRIDGE_PULL_CACHE,
        BridgeFlagsService,
        BridgeFlagGuard,
        BridgeContextInterceptor,
      ],
    };
  }
}

function buildBridge(opts: BridgeFlagsModuleOptions): BridgeFlags {
  const bridge = new BridgeFlags({ mode: opts.mode ?? 'backend' });
  if (opts.serverInstanceId) {
    bridge.setServerInstanceId(opts.serverInstanceId);
  }
  if (opts.initialContext) {
    bridge.setContext(opts.initialContext, true);
  }

  // Phase 6 (TBP-290/340) — runtime mode. 'pull' skips RealtimeClient
  // entirely (no WebSocket); reads go through a TTL-bounded REST cache
  // (`BridgePullCache` — wired by callers via the public token). Default
  // is 'channel' (live WebSocket updates) for long-running NestJS services.
  const runtimeMode = opts.runtimeMode ?? 'channel';

  // Realtime — opt-in, but `enabled: undefined` defaults to true in the
  // RealtimeClient itself. Skip the websocket on serverless / test deploys
  // by setting `realtime: { enabled: false }`, OR by setting
  // `runtimeMode: 'pull'` (which forces `enabled: false` regardless of the
  // raw realtime opts).
  const realtime = new RealtimeClient({
    apiBaseUrl: opts.apiBaseUrl,
    apiKey: opts.apiKey,
    ...opts.realtime,
    ...(runtimeMode === 'pull' ? { enabled: false } : {}),
  });
  realtime.attach(bridge);

  const telemetry = new TelemetryBatcher({
    apiBaseUrl: opts.apiBaseUrl,
    apiKey: opts.apiKey,
    ...opts.telemetry,
  });

  // Compose hooks: telemetry baseline + user-supplied.
  const userHooks: BridgeFlagsHooks = opts.hooks ?? {};
  let capturedFromBatcher: BridgeFlagsHooks = {};
  const originalSetHooks = bridge.setHooks.bind(bridge);
  bridge.setHooks = (h: BridgeFlagsHooks): void => {
    capturedFromBatcher = h ?? {};
  };
  try {
    telemetry.attach(bridge);
  } finally {
    bridge.setHooks = originalSetHooks;
  }
  bridge.setHooks({
    onEval: (ev) => {
      try {
        capturedFromBatcher.onEval?.(ev);
      } catch {
        /* swallow */
      }
      try {
        userHooks.onEval?.(ev);
      } catch {
        /* swallow */
      }
    },
    onDiscover: (ev) => {
      try {
        capturedFromBatcher.onDiscover?.(ev);
      } catch {
        /* swallow */
      }
      try {
        userHooks.onDiscover?.(ev);
      } catch {
        /* swallow */
      }
    },
    onAttributeDeclaration: (decl) => {
      try {
        capturedFromBatcher.onAttributeDeclaration?.(decl);
      } catch {
        /* swallow */
      }
      try {
        userHooks.onAttributeDeclaration?.(decl);
      } catch {
        /* swallow */
      }
    },
  });

  // Best-effort start. Becomes a hard no-op in pull mode because
  // `enabled: false` was forced above. In channel mode the start is
  // best-effort: a server returning kind: 'noop' results in no WS at all.
  void realtime.start();

  // Wire a single teardown hook that stops both realtime + telemetry.
  // BridgeFlagsService picks this up via the options token and calls it
  // on `onModuleDestroy`.
  opts.onTelemetryStop = async (): Promise<void> => {
    await realtime.stop();
    await telemetry.stop();
  };

  return bridge;
}
