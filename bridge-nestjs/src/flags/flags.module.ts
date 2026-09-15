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

import { Global, Logger, Module, type DynamicModule, type Provider } from '@nestjs/common';
import {
  BridgeFlags,
  BridgePullCache,
  RealtimeClient,
  TelemetryBatcher,
  type BridgeFlagsHooks,
} from '@nebulr-group/bridge-auth-core';

import { FlagRulesLoader, appIdFromApiKey, realtimeAcceptsApiToken } from './flag-rules';
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

/** How long module init waits for the first rule load before serving anyway. */
const INITIAL_LOAD_TIMEOUT_MS = 5_000;
/** Rule refresh interval without a live channel (`pullCache.ttlMs` overrides). */
const DEFAULT_REFRESH_MS = 30_000;

async function buildBridge(opts: BridgeFlagsModuleOptions): Promise<BridgeFlags> {
  const bridge = new BridgeFlags({ mode: opts.mode ?? 'backend' });
  if (opts.serverInstanceId) {
    bridge.setServerInstanceId(opts.serverInstanceId);
  }
  if (opts.initialContext) {
    bridge.setContext(opts.initialContext, true);
  }

  // Phase 6 (TBP-290/340) — runtime mode. 'pull' never opens a WebSocket;
  // 'channel' (default) keeps one open where Bridge lets a server SDK in.
  const runtimeMode = opts.runtimeMode ?? 'channel';
  const logger = new Logger('BridgeFlags');
  const apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, '');
  const fetchFn: typeof fetch = opts.realtime?.fetchFn ?? ((...args) => globalThis.fetch(...args));
  const refreshMs = opts.pullCache?.ttlMs ?? DEFAULT_REFRESH_MS;
  const appId = opts.appId ?? opts.realtime?.appId ?? appIdFromApiKey(opts.apiKey);

  // TBP-644 — the rule cache. Nothing used to fill it, so every flag() on a
  // server answered its default (see flag-rules.ts).
  let lastLoadError: string | undefined;
  const loader = appId
    ? new FlagRulesLoader(bridge, {
        apiBaseUrl,
        appId,
        fetchFn,
        onError: (message) => {
          if (message !== lastLoadError) logger.warn(message);
          lastLoadError = message;
        },
      })
    : undefined;
  if (!loader) {
    logger.warn(
      'No app id: pass `appId` to BridgeFlagsModule.forRoot (or use a Bridge API token as `apiKey`). Without it the flag rules cannot be loaded and every flag() returns its default.',
    );
  }

  // TBP-644 — the live channel. Flag pushes go to `app:<appId>`, and the
  // AppSync authorizer only admits a server to it with a credential it can
  // verify: this client used to connect with NO appId (so no channel at all)
  // and NO token (AppSync refuses an empty Authorization before the
  // authorizer runs — a reconnect loop that never delivered a push). The
  // server's credential is its API token; bridge-api advertises on
  // `/realtime/config` when its authorizer accepts one, and until it does we
  // don't connect at all (a refused socket every 30 s helps nobody) — the
  // TTL refresh below keeps flags converging either way.
  const wantLive = runtimeMode !== 'pull' && opts.realtime?.enabled !== false && !!appId;
  let realtime: RealtimeClient | undefined;
  let stopped = false;
  let probing = false;
  let lastProbeAt = 0;
  let toldUnavailable = false;
  const startLive = async (): Promise<void> => {
    if (!wantLive || realtime || probing || stopped) return;
    if (lastProbeAt !== 0 && Date.now() - lastProbeAt < refreshMs) return;
    probing = true;
    lastProbeAt = Date.now();
    try {
      const res = await fetchFn(`${apiBaseUrl}/realtime/config`, { headers: { 'x-api-key': opts.apiKey } });
      if (!res.ok || stopped) return; // transient — retried after refreshMs
      if (!realtimeAcceptsApiToken(await res.json())) {
        if (!toldUnavailable) {
          toldUnavailable = true;
          logger.log(
            `Live flag updates are not available to server SDKs on this Bridge deployment; flag rules refresh every ${Math.round(refreshMs / 1000)}s instead.`,
          );
        }
        return;
      }
      const client = new RealtimeClient({
        apiBaseUrl,
        apiKey: opts.apiKey,
        appId,
        getAuthToken: () => opts.apiKey,
        ...opts.realtime,
      });
      client.attach(bridge);
      // Catch up on anything changed while the socket was down.
      client.setOnOpen(() => {
        void loader?.refresh();
      });
      realtime = client;
      void client.start();
    } catch {
      // network — retried after refreshMs
    } finally {
      probing = false;
    }
  };

  // Without an open channel (pull mode, a refused or dropped socket, a
  // deployment that doesn't admit servers) the rules refresh at most every
  // `refreshMs`, driven by reads — so an idle serverless function does no
  // work, and nothing depends on a timer surviving a frozen runtime. Wrapping
  // `flag` covers every read path: the service, BridgeFlagGuard, @Flag, and
  // direct use of the BRIDGE_FLAGS instance.
  const evaluate = bridge.flag.bind(bridge);
  bridge.flag = ((key: string, defaultValue: unknown, context?: Parameters<BridgeFlags['flag']>[2]) => {
    if (realtime?.getState() !== 'open') {
      loader?.refreshIfOlderThan(refreshMs);
      void startLive();
    }
    return evaluate(key, defaultValue, context);
  }) as unknown as BridgeFlags['flag'];

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

  // Wire a single teardown hook that stops both realtime + telemetry.
  // BridgeFlagsService picks this up via the options token and calls it
  // on `onModuleDestroy`.
  opts.onTelemetryStop = async (): Promise<void> => {
    stopped = true;
    await realtime?.stop();
    await telemetry.stop();
  };

  // Serve with rules loaded: the module's provider is async, so Nest finishes
  // init only after the first load — bounded, so a Bridge outage at boot
  // delays startup by at most INITIAL_LOAD_TIMEOUT_MS and flags then answer
  // their defaults until a later refresh succeeds.
  await settleWithin(Promise.all([loader?.refresh(), startLive()]), INITIAL_LOAD_TIMEOUT_MS);

  return bridge;
}

async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  await Promise.race([work.catch(() => undefined), timeout]);
  if (timer) clearTimeout(timer);
}
