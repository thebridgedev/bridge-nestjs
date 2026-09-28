// TBP-671 — a client-supplied `x-bridge-context` header must not change any
// flag evaluation or guard decision.
//
// Before the fix, `BridgeContextInterceptor` took identity and attributes from
// that header ahead of the verified user, and auth-core merges per-call
// attributes OVER provider/global ones — so a request carrying
// `tenant.plan: enterprise` and a victim's `sub` was evaluated as the victim on
// the enterprise plan. These tests drive the real pieces in NestJS's order
// (guard → interceptor → param decorator) against a real, offline BridgeFlags.

import 'reflect-metadata';

import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { serializeContext, type CachedFlag } from '@nebulr-group/bridge-auth-core';
import { lastValueFrom, of } from 'rxjs';

import { BridgeFlagsModule } from './flags.module';
import { BridgeFlagsService } from './flags.service';
import { BridgeFlagGuard } from './flag.guard';
import { FeatureNotInPlanException } from './feature-refusal';
import { BridgeContextInterceptor } from './flag.interceptor';
import { Flag, REQUIRE_FLAG_KEY } from './flag.decorator';

const OFFLINE_OPTS = {
  apiBaseUrl: 'http://localhost:3500',
  apiKey: 'test-key',
  realtime: { enabled: false },
  telemetry: { enabled: false },
};

const VICTIM = 'victim-sub';
const REAL_USER = 'real-user';

// On only for the enterprise plan.
const PLAN_GATE: CachedFlag = {
  key: 'plan_gate',
  state: 'on-with-rule',
  valueType: 'boolean',
  offValue: false,
  onValue: true,
  rule: {
    branches: [
      {
        conditions: [{ attribute: 'tenant.plan', operator: 'eq', values: ['enterprise'] }],
        returnValue: true,
      },
    ],
    otherwiseValue: false,
    rolloutPct: 100,
  },
};

// On only for the victim.
const VICTIM_ONLY: CachedFlag = {
  key: 'victim_only',
  state: 'on-with-rule',
  valueType: 'boolean',
  offValue: false,
  onValue: true,
  rule: {
    branches: [
      {
        conditions: [{ attribute: 'user.id', operator: 'eq', values: [VICTIM] }],
        returnValue: true,
      },
    ],
    otherwiseValue: false,
    rolloutPct: 100,
  },
};

// On for anybody with an identity (backend mode refuses to evaluate a rule
// without one and returns the default).
const SIGNED_IN: CachedFlag = {
  key: 'signed_in',
  state: 'on-with-rule',
  valueType: 'boolean',
  offValue: false,
  onValue: true,
  rule: { branches: [], otherwiseValue: true, rolloutPct: 100 },
};

/** The spoofed header: somebody else's sub, on a plan they don't pay for. */
const SPOOFED_HEADER = serializeContext({
  identity: VICTIM,
  attributes: { tenant: { plan: 'enterprise' }, user: { id: VICTIM } },
});

function httpContext(req: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => undefined }),
    getHandler: () => () => undefined,
    getClass: () => class Stub {},
  } as unknown as ExecutionContext;
}

/** The factory NestJS runs to resolve `@Flag(...)` for a handler param. */
function flagParamFactory(): (data: unknown, ctx: ExecutionContext) => unknown {
  class Ctl {
    handler(@Flag({ key: 'unused', defaultValue: false }) _v: boolean) {
      /* noop */
    }
  }
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Ctl, 'handler');
  return args[Object.keys(args)[0]].factory;
}

describe('TBP-671 — x-bridge-context is never trusted', () => {
  let moduleRef: TestingModule;
  let service: BridgeFlagsService;
  let interceptor: BridgeContextInterceptor;
  let reflector: Reflector;
  let guard: BridgeFlagGuard;
  const flagParam = flagParamFactory();
  const next = { handle: () => of(null) } as any;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [BridgeFlagsModule.forRoot(OFFLINE_OPTS)],
    }).compile();
    service = moduleRef.get(BridgeFlagsService);
    interceptor = moduleRef.get(BridgeContextInterceptor);
    reflector = new Reflector();
    guard = new BridgeFlagGuard(reflector, service);
    service.hydrate([PLAN_GATE, VICTIM_ONLY, SIGNED_IN]);
    // What an attribute provider reading the VERIFIED JWT would contribute:
    // the real user is on the free plan.
    service.setContext({ attributes: { tenant: { plan: 'free' }, user: { id: REAL_USER } } });
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  /** Run a request through guard → interceptor, as NestJS does. */
  async function run(req: any, requireFlag?: string): Promise<{ allowed: boolean | 'forbidden'; ctx: ExecutionContext }> {
    const ctx = httpContext(req);
    let allowed: boolean | 'forbidden' = true;
    if (requireFlag) {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValue({ key: requireFlag, defaultValue: false, options: {} });
      try {
        allowed = await guard.canActivate(ctx);
      } catch (err) {
        // TBP-756: a plan-gated refusal is a 402, a role/off one a 403 — both refuse.
        if (!(err instanceof ForbiddenException || err instanceof FeatureNotInPlanException)) throw err;
        allowed = 'forbidden';
      }
    }
    await lastValueFrom(interceptor.intercept(ctx, next));
    return { allowed, ctx };
  }

  const evalParam = (ctx: ExecutionContext, key: string) =>
    flagParam({ key, defaultValue: false }, ctx);

  describe('verified user + spoofed header', () => {
    const request = () => ({
      headers: { 'x-bridge-context': SPOOFED_HEADER },
      bridgeUser: { id: REAL_USER },
    });

    it('the per-request context carries the verified identity and no header attributes', async () => {
      const { ctx } = await run(request());
      expect((ctx.switchToHttp().getRequest() as any).bridgeFlagsContext).toEqual({
        identity: REAL_USER,
        attributes: {},
      });
    });

    it('@Flag does not unlock the plan-gated flag', async () => {
      const { ctx } = await run(request());
      expect(evalParam(ctx, 'plan_gate')).toBe(false);
    });

    it('@Flag does not unlock the victim-targeted flag', async () => {
      const { ctx } = await run(request());
      expect(evalParam(ctx, 'victim_only')).toBe(false);
    });

    it('flags.flag() with req.bridgeFlagsContext does not unlock either flag', async () => {
      const { ctx } = await run(request());
      const perRequest = (ctx.switchToHttp().getRequest() as any).bridgeFlagsContext;
      expect(service.flag('plan_gate', false, perRequest)).toBe(false);
      expect(service.flag('victim_only', false, perRequest)).toBe(false);
    });

    it('@RequireFlag refuses the plan-gated route', async () => {
      expect((await run(request(), 'plan_gate')).allowed).toBe('forbidden');
    });
  });

  describe('no verified user + spoofed header (anonymous)', () => {
    const request = () => ({ headers: { 'x-bridge-context': SPOOFED_HEADER } });

    it('evaluates anonymously — no per-request context at all', async () => {
      const { ctx } = await run(request());
      expect((ctx.switchToHttp().getRequest() as any).bridgeFlagsContext).toBeUndefined();
    });

    it('@Flag returns the defaults, not the spoofed identity\'s values', async () => {
      const { ctx } = await run(request());
      expect(evalParam(ctx, 'plan_gate')).toBe(false);
      expect(evalParam(ctx, 'victim_only')).toBe(false);
      expect(evalParam(ctx, 'signed_in')).toBe(false);
    });

    it('@RequireFlag refuses a route that needs an identity', async () => {
      expect((await run(request(), 'signed_in')).allowed).toBe('forbidden');
    });
  });

  describe('the guard reads nothing a client can set', () => {
    it('ignores a spoofed context already copied onto the request', async () => {
      // e.g. an app middleware that copied the header onto the request, or a
      // guard bound after an interceptor in a custom pipeline.
      const req = {
        bridgeUser: { id: REAL_USER },
        bridgeFlagsContext: { identity: VICTIM, attributes: { tenant: { plan: 'enterprise' } } },
      };
      expect((await run(req, 'plan_gate')).allowed).toBe('forbidden');
    });
  });

  describe('the verified user still drives evaluation', () => {
    it('@Flag and @RequireFlag pass for a user who really is on enterprise', async () => {
      service.setContext({ attributes: { tenant: { plan: 'enterprise' } } }, true);
      const { allowed, ctx } = await run({ bridgeUser: { id: REAL_USER } }, 'plan_gate');
      expect(allowed).toBe(true);
      expect(evalParam(ctx, 'plan_gate')).toBe(true);
    });

    it('@RequireFlag buckets on the verified identity (guards run before the interceptor)', async () => {
      expect((await run({ bridgeUser: { id: REAL_USER } }, 'signed_in')).allowed).toBe(true);
    });

    it('falls back to req.user from the app\'s own auth', async () => {
      const { allowed, ctx } = await run({ user: { id: REAL_USER } }, 'signed_in');
      expect(allowed).toBe(true);
      expect(evalParam(ctx, 'signed_in')).toBe(true);
    });
  });
});

// Keep the metadata key referenced so a rename breaks this spec loudly.
void REQUIRE_FLAG_KEY;
