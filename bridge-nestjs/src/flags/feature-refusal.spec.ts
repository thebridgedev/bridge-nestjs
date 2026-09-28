// TBP-756 — a flag-gated endpoint says why it refused: 402 FEATURE_NOT_IN_PLAN
// when an upgrade alone would turn the feature on, 403 FEATURE_NOT_PERMITTED
// for a role/privilege reason, 403 FEATURE_OFF otherwise — for both
// `@RequireFlag` (BridgeFlagGuard, local rules) and `@RequireFeatureFlag` /
// route rules (BridgeAuthGuard, Bridge's evaluate endpoint).

import 'reflect-metadata';

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
  errors: {
    JWTExpired: class extends Error {},
    JWTInvalid: class extends Error {},
    JWKSNoMatchingKey: class extends Error {},
    JWTClaimValidationFailed: class extends Error {},
  },
}));

import { ExecutionContext, ForbiddenException, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { CachedFlag } from '@nebulr-group/bridge-auth-core';

import { rememberVerifiedUserToken } from '../bridge/verified-request';
import type { JwtClaims } from '../types/user';
import { BridgeAuthGuard } from '../guards/bridge-auth.guard';
import { FeatureFlagService } from '../services/feature-flag.service';
import { REQUIRED_FEATURE_FLAG_KEY } from '../decorators/require-feature-flag.decorator';
import { REQUIRE_FLAG_KEY } from './flag.decorator';
import { BridgeFlagGuard } from './flag.guard';
import { BridgeFlagsModule } from './flags.module';
import { BridgeFlagsService } from './flags.service';
import {
  FeatureForbiddenException,
  FeatureNotInPlanException,
  featureRefusalBody,
} from './feature-refusal';

afterEach(() => jest.restoreAllMocks());

async function refusal(p: Promise<unknown>): Promise<{ status: number; body: any; error: unknown }> {
  try {
    await p;
  } catch (error) {
    if (error instanceof HttpException) return { status: error.getStatus(), body: error.getResponse(), error };
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('featureRefusalBody', () => {
  it('plan → 402 FEATURE_NOT_IN_PLAN with the upgrade path and the feature', () => {
    expect(featureRefusalBody('analytics', { reason: 'plan', feature: 'reports' }, '/billing')).toEqual({
      statusCode: 402,
      code: 'FEATURE_NOT_IN_PLAN',
      error: 'Payment Required',
      message: "Your plan does not include 'reports'. Upgrade to use it.",
      flag: 'analytics',
      reason: 'plan',
      feature: 'reports',
      fix: '/billing',
    });
  });

  it('permission → 403 FEATURE_NOT_PERMITTED', () => {
    expect(featureRefusalBody('admin', { reason: 'permission' })).toMatchObject({
      statusCode: 403,
      code: 'FEATURE_NOT_PERMITTED',
      flag: 'admin',
      fix: 'Ask a workspace admin for access.',
    });
  });

  it.each(['off', 'rule', 'rollout', undefined] as const)('%s → 403 FEATURE_OFF', (reason) => {
    const body = featureRefusalBody('beta', reason ? { reason } : {});
    expect(body).toMatchObject({ statusCode: 403, code: 'FEATURE_OFF', flag: 'beta', error: 'Forbidden' });
    expect(body.message).toBe("Feature flag 'beta' is not enabled");
    expect(typeof body.fix).toBe('string');
  });

  it('plan without a manageRoute defaults to /subscription', () => {
    expect(featureRefusalBody('x', { reason: 'plan' }).fix).toBe('/subscription');
  });
});

// ── @RequireFlag — local rules through auth-core's evaluator ─────────────────

const ENT = 'bridge:billing.entitlement.reports';
const rule = (attribute: string, operator: string, value: unknown) => ({
  branches: [{ conditions: [{ attribute, operator, values: [value] }], returnValue: true }],
  otherwiseValue: false,
  rolloutPct: 100,
});
const FLAGS: CachedFlag[] = [
  { key: 'plan_gated', state: 'on-with-rule', valueType: 'boolean', offValue: false, onValue: true, rule: rule(ENT, 'eq', true) as any },
  { key: 'owner_only', state: 'on-with-rule', valueType: 'boolean', offValue: false, onValue: true, rule: rule('user.role', 'eq', 'OWNER') as any },
  { key: 'killed', state: 'off', valueType: 'boolean', offValue: false, onValue: true },
];

function flagContext(req: any, key: string): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(REQUIRE_FLAG_KEY, { key, defaultValue: false, options: {} }, handler);
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => undefined }),
    getHandler: () => handler,
    getClass: () => class Stub {},
  } as unknown as ExecutionContext;
}

function verifiedRequest(c: Partial<JwtClaims>): any {
  const claims = { sub: 'u1', tid: 't1', role: 'MEMBER', privileges: [], iat: 1, ...c } as JwtClaims;
  const req: any = { headers: {}, bridgeUser: { id: claims.sub, role: claims.role } };
  rememberVerifiedUserToken(req, 'token-1', claims);
  return req;
}

describe('BridgeFlagGuard (@RequireFlag) refusals', () => {
  async function guardWith(manageRoute?: string): Promise<BridgeFlagGuard> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BridgeFlagsModule.forRoot({
          apiBaseUrl: 'http://bridge.test',
          apiKey: 'k',
          appId: 'app-1',
          realtime: { enabled: false },
          telemetry: { enabled: false },
          ...(manageRoute ? { manageRoute } : {}),
        }),
      ],
    }).compile();
    moduleRef.get(BridgeFlagsService).hydrate(FLAGS);
    return moduleRef.get(BridgeFlagGuard);
  }

  it('a plan-feature rule refuses with 402 FEATURE_NOT_IN_PLAN naming the feature', async () => {
    const guard = await guardWith('/billing/upgrade');
    const r = await refusal(guard.canActivate(flagContext(verifiedRequest({}), 'plan_gated')));
    expect(r.status).toBe(402);
    expect(r.error).toBeInstanceOf(FeatureNotInPlanException);
    expect(r.body).toMatchObject({
      code: 'FEATURE_NOT_IN_PLAN',
      flag: 'plan_gated',
      feature: 'reports',
      fix: '/billing/upgrade',
    });
  });

  it('a role rule refuses with 403 FEATURE_NOT_PERMITTED, still a ForbiddenException', async () => {
    const guard = await guardWith();
    const r = await refusal(guard.canActivate(flagContext(verifiedRequest({ role: 'MEMBER' }), 'owner_only')));
    expect(r.status).toBe(403);
    expect(r.error).toBeInstanceOf(ForbiddenException);
    expect(r.error).toBeInstanceOf(FeatureForbiddenException);
    expect(r.body).toMatchObject({ code: 'FEATURE_NOT_PERMITTED', flag: 'owner_only', reason: 'permission' });
  });

  it('a switched-off flag refuses with 403 FEATURE_OFF', async () => {
    const guard = await guardWith();
    const r = await refusal(guard.canActivate(flagContext(verifiedRequest({ role: 'OWNER' }), 'killed')));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'FEATURE_OFF', flag: 'killed', reason: 'off' });
  });

  it('the owner passes the role rule', async () => {
    const guard = await guardWith();
    await expect(guard.canActivate(flagContext(verifiedRequest({ role: 'OWNER' }), 'owner_only'))).resolves.toBe(true);
  });
});

// ── @RequireFeatureFlag / route rules — Bridge's evaluate endpoint ───────────

describe('BridgeAuthGuard (@RequireFeatureFlag, route rules) refusals', () => {
  const claims = { sub: 'user-1', tid: 'tenant-1', role: 'USER', email: 'u@x.test' };

  function build(evaluations: Array<{ flag: string; evaluation: Record<string, unknown> }>) {
    jest.spyOn(globalThis, 'fetch').mockImplementation((async () => ({
      ok: true,
      status: 200,
      json: async () => ({ flags: evaluations }),
    })) as any);
    const configService: any = {
      log: jest.fn(),
      findMatchingRule: jest.fn().mockReturnValue({ path: '/x/*', privilege: 'AUTHENTICATED' }),
      defaultAccess: 'protected',
      appId: 'app-1',
      cloudViewsBaseUrl: 'http://bridge.test/cloud-views',
      manageRoute: '/subscription',
    };
    const reflector: any = { getAllAndOverride: jest.fn() };
    const jwks: any = { verifyToken: jest.fn().mockResolvedValue(claims), verifyApiToken: jest.fn() };
    const flags = new FeatureFlagService(configService);
    const guard = new BridgeAuthGuard(reflector, configService, jwks, flags, {
      fromJwt: jest.fn(),
      fromRequest: jest.fn(),
    } as any);
    return { guard, reflector, configService };
  }

  function ctx(): ExecutionContext {
    const request: any = { path: '/x/y', method: 'GET', headers: { authorization: 'Bearer token' } };
    return {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader: jest.fn() }) }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
      getType: () => 'http',
    } as unknown as ExecutionContext;
  }

  function requireFlag(reflector: any, flag: unknown) {
    reflector.getAllAndOverride.mockImplementation((key: string) =>
      key === REQUIRED_FEATURE_FLAG_KEY ? flag : undefined,
    );
  }

  it('plan reason from Bridge → 402 FEATURE_NOT_IN_PLAN with the feature and fix', async () => {
    const { guard, reflector } = build([
      { flag: 'analytics', evaluation: { enabled: false, reason: 'plan', feature: 'reports' } },
    ]);
    requireFlag(reflector, 'analytics');
    const r = await refusal(guard.canActivate(ctx()));
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({
      statusCode: 402,
      code: 'FEATURE_NOT_IN_PLAN',
      flag: 'analytics',
      feature: 'reports',
      fix: '/subscription',
    });
  });

  it('permission reason → 403 FEATURE_NOT_PERMITTED', async () => {
    const { guard, reflector } = build([{ flag: 'admin', evaluation: { enabled: false, reason: 'permission' } }]);
    requireFlag(reflector, 'admin');
    const r = await refusal(guard.canActivate(ctx()));
    expect(r.status).toBe(403);
    expect(r.error).toBeInstanceOf(ForbiddenException);
    expect(r.body).toMatchObject({ code: 'FEATURE_NOT_PERMITTED', flag: 'admin' });
  });

  it('off reason, and a Bridge that sends no reason → 403 FEATURE_OFF', async () => {
    for (const evaluation of [{ enabled: false, reason: 'off' }, { enabled: false }]) {
      const { guard, reflector } = build([{ flag: 'beta', evaluation }]);
      requireFlag(reflector, 'beta');
      const r = await refusal(guard.canActivate(ctx()));
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: 'FEATURE_OFF', flag: 'beta', message: "Feature flag 'beta' is not enabled" });
    }
  });

  it('{ any }: an upgrade alone opens one of them → 402', async () => {
    const { guard, reflector } = build([
      { flag: 'a', evaluation: { enabled: false, reason: 'permission' } },
      { flag: 'b', evaluation: { enabled: false, reason: 'plan' } },
    ]);
    requireFlag(reflector, { any: ['a', 'b'] });
    const r = await refusal(guard.canActivate(ctx()));
    expect(r.status).toBe(402);
  });

  it('{ all }: another failing flag is a permission → 403 FEATURE_NOT_PERMITTED', async () => {
    const { guard, reflector } = build([
      { flag: 'a', evaluation: { enabled: false, reason: 'plan' } },
      { flag: 'b', evaluation: { enabled: false, reason: 'permission' } },
    ]);
    requireFlag(reflector, { all: ['a', 'b'] });
    const r = await refusal(guard.canActivate(ctx()));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'FEATURE_NOT_PERMITTED' });
  });

  it('a route rule featureFlag refuses the same way', async () => {
    const { guard, reflector, configService } = build([
      { flag: 'reports', evaluation: { enabled: false, reason: 'plan', feature: 'reports' } },
    ]);
    reflector.getAllAndOverride.mockReturnValue(undefined);
    configService.findMatchingRule.mockReturnValue({ path: '/x/*', privilege: 'AUTHENTICATED', featureFlag: 'reports' });
    const r = await refusal(guard.canActivate(ctx()));
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ code: 'FEATURE_NOT_IN_PLAN', flag: 'reports' });
  });
});
