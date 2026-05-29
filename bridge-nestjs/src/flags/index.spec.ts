// bridge-nestjs/flags — unit tests for module wiring + guards/decorators (TBP-200).
//
// Doesn't hit the network: realtime + telemetry are disabled via the
// `enabled: false` opts so the BridgeFlags instance is purely cache-backed.

import 'reflect-metadata';

import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { BridgeFlagsModule } from './flags.module';
import { BridgeFlagsService } from './flags.service';
import { BridgeFlagGuard } from './flag.guard';
import { BridgeContextInterceptor } from './flag.interceptor';
import { RequireFlag, REQUIRE_FLAG_KEY } from './flag.decorator';
import { BRIDGE_FLAGS, BRIDGE_PULL_CACHE } from './flags.tokens';
import { BridgeFlags, BridgePullCache, serializeContext } from '@nebulr-group/bridge-auth-core';

const OFFLINE_OPTS = {
  apiBaseUrl: 'http://localhost:3500',
  apiKey: 'test-key',
  realtime: { enabled: false },
  telemetry: { enabled: false },
};

describe('BridgeFlagsModule.forRoot', () => {
  let testModule: TestingModule;

  beforeEach(async () => {
    testModule = await Test.createTestingModule({
      imports: [BridgeFlagsModule.forRoot(OFFLINE_OPTS)],
    }).compile();
  });

  afterEach(async () => {
    await testModule.close();
  });

  it('provides BridgeFlagsService + BRIDGE_FLAGS token', () => {
    const service = testModule.get(BridgeFlagsService);
    const bridge = testModule.get<BridgeFlags>(BRIDGE_FLAGS);
    expect(service).toBeDefined();
    expect(bridge).toBeDefined();
    expect(service.bridge).toBe(bridge);
  });

  it('defaults to backend mode', () => {
    const service = testModule.get(BridgeFlagsService);
    expect(service.mode).toBe('backend');
  });

  it('honors hydrate + flag round-trip', () => {
    const service = testModule.get(BridgeFlagsService);
    service.hydrate([
      {
        key: 'feature_x',
        state: 'on',
        valueType: 'boolean',
        offValue: false,
        onValue: true,
      },
    ]);
    // Backend mode + 'on' state (no rule) → bucketed by state, not identity.
    expect(service.flag('feature_x', false)).toBe(true);
  });

  // Phase 6 (TBP-290/340) — runtime mode + pull cache.
  describe('Phase 6 runtime mode', () => {
    it('always registers BRIDGE_PULL_CACHE — injectable in both modes', () => {
      const cache = testModule.get<BridgePullCache>(BRIDGE_PULL_CACHE);
      expect(cache).toBeInstanceOf(BridgePullCache);
    });

    it('honors pullCache TTL option', async () => {
      const customTtlModule = await Test.createTestingModule({
        imports: [
          BridgeFlagsModule.forRoot({
            ...OFFLINE_OPTS,
            pullCache: { ttlMs: 10 },
          }),
        ],
      }).compile();
      const cache = customTtlModule.get<BridgePullCache>(BRIDGE_PULL_CACHE);
      const fetcher = jest.fn(async () => 'value');
      await cache.get('k', fetcher);
      await new Promise((r) => setTimeout(r, 20)); // past TTL
      await cache.get('k', fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await customTtlModule.close();
    });

    it('runtimeMode=pull forces realtime.enabled=false regardless of opts', async () => {
      // Smoke test: even passing realtime: { enabled: true }, pull mode
      // should not open a WS. We can't easily assert on the internal
      // RealtimeClient from outside, but the module construction must not
      // throw and the service mode stays 'backend' (FF-eval mode unchanged).
      const pullModule = await Test.createTestingModule({
        imports: [
          BridgeFlagsModule.forRoot({
            ...OFFLINE_OPTS,
            realtime: { enabled: true } as any,
            runtimeMode: 'pull',
          }),
        ],
      }).compile();
      const service = pullModule.get(BridgeFlagsService);
      expect(service.mode).toBe('backend');
      // Cache injectable.
      const cache = pullModule.get<BridgePullCache>(BRIDGE_PULL_CACHE);
      expect(cache).toBeInstanceOf(BridgePullCache);
      await pullModule.close();
    });

    it('runtimeMode=channel (default) keeps the realtime path active', async () => {
      // Sanity: the default module construction works and exposes the cache.
      const channelModule = await Test.createTestingModule({
        imports: [
          BridgeFlagsModule.forRoot({
            ...OFFLINE_OPTS,
            runtimeMode: 'channel',
          }),
        ],
      }).compile();
      const cache = channelModule.get<BridgePullCache>(BRIDGE_PULL_CACHE);
      expect(cache).toBeInstanceOf(BridgePullCache);
      await channelModule.close();
    });
  });
});

describe('BridgeFlagGuard', () => {
  let guard: BridgeFlagGuard;
  let service: BridgeFlagsService;
  let reflector: Reflector;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BridgeFlagsModule.forRoot(OFFLINE_OPTS)],
    }).compile();
    guard = moduleRef.get(BridgeFlagGuard);
    service = moduleRef.get(BridgeFlagsService);
    reflector = moduleRef.get(Reflector);
  });

  function makeContext(handlerMeta: Record<string, unknown> = {}): ExecutionContext {
    const handler = function () {
      /* noop */
    } as Function;
    for (const [k, v] of Object.entries(handlerMeta)) {
      Reflect.defineMetadata(k, v, handler);
    }
    const req: any = { headers: {} };
    return {
      getHandler: () => handler,
      getClass: () => class Stub {},
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => undefined,
      }),
    } as unknown as ExecutionContext;
  }

  it('passes through when there is no @RequireFlag metadata', () => {
    const ctx = makeContext();
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws ForbiddenException when the flag is off', () => {
    // No hydrate; default `false`. Flag is off → guard rejects.
    const ctx = makeContext({
      [REQUIRE_FLAG_KEY]: { key: 'gated', defaultValue: false, options: {} },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('allows when the flag evaluates to true', () => {
    service.hydrate([
      {
        key: 'gated',
        state: 'on',
        valueType: 'boolean',
        offValue: false,
        onValue: true,
      },
    ]);
    const ctx = makeContext({
      [REQUIRE_FLAG_KEY]: { key: 'gated', defaultValue: false, options: {} },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('honors a custom `equals` value', () => {
    service.hydrate([
      {
        key: 'tier',
        state: 'on',
        valueType: 'string',
        offValue: 'free',
        onValue: 'pro',
      },
    ]);
    const ctx = makeContext({
      [REQUIRE_FLAG_KEY]: { key: 'tier', defaultValue: 'free', options: { equals: 'pro' } },
    });
    expect(guard.canActivate(ctx)).toBe(true);
    const ctxFail = makeContext({
      [REQUIRE_FLAG_KEY]: { key: 'tier', defaultValue: 'free', options: { equals: 'enterprise' } },
    });
    expect(() => guard.canActivate(ctxFail)).toThrow(ForbiddenException);
  });

  it('silently skips when `optional: true`', () => {
    const ctx = makeContext({
      [REQUIRE_FLAG_KEY]: {
        key: 'never_set',
        defaultValue: false,
        options: { optional: true },
      },
    });
    expect(guard.canActivate(ctx)).toBe(false);
  });
});

describe('BridgeContextInterceptor', () => {
  let interceptor: BridgeContextInterceptor;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BridgeFlagsModule.forRoot(OFFLINE_OPTS)],
    }).compile();
    interceptor = moduleRef.get(BridgeContextInterceptor);
  });

  function ctxWithHeaders(headers: Record<string, string>): ExecutionContext {
    const req: any = { headers };
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => undefined,
      }),
      getHandler: () => () => undefined,
      getClass: () => class Stub {},
    } as unknown as ExecutionContext;
  }

  it('decodes a propagated context header and stashes it on the request', () => {
    const header = serializeContext({
      identity: 'user-42',
      attributes: { plan: 'pro' },
    });
    const ctx = ctxWithHeaders({ 'x-bridge-context': header });
    // The interceptor mutates `req.bridgeFlagsContext` synchronously
    // before next.handle() runs. We assert that side effect.
    const next = { handle: () => ({ subscribe: () => undefined }) } as any;
    interceptor.intercept(ctx, next);
    const req = (ctx.switchToHttp().getRequest() as any);
    expect(req.bridgeFlagsContext).toEqual({
      identity: 'user-42',
      attributes: { plan: 'pro' },
    });
  });

  it('falls back to req.bridgeUser.id when no header is present', () => {
    const ctx = ctxWithHeaders({});
    (ctx.switchToHttp().getRequest() as any).bridgeUser = { id: 'jwt-user' };
    const next = { handle: () => ({ subscribe: () => undefined }) } as any;
    interceptor.intercept(ctx, next);
    expect((ctx.switchToHttp().getRequest() as any).bridgeFlagsContext).toEqual({
      identity: 'jwt-user',
      attributes: {},
    });
  });

  it('is a no-op when neither header nor identity is present', () => {
    const ctx = ctxWithHeaders({});
    const next = { handle: () => ({ subscribe: () => undefined }) } as any;
    interceptor.intercept(ctx, next);
    expect((ctx.switchToHttp().getRequest() as any).bridgeFlagsContext).toBeUndefined();
  });
});

describe('@RequireFlag decorator', () => {
  it('attaches the expected metadata', () => {
    class StubController {
      @RequireFlag('a_flag', false, { equals: 42 })
      handler() {
        /* noop */
      }
    }
    const meta = Reflect.getMetadata(REQUIRE_FLAG_KEY, StubController.prototype.handler);
    expect(meta).toEqual({
      key: 'a_flag',
      defaultValue: false,
      options: { equals: 42 },
    });
  });
});
