// TBP-757 — a flag rule on role, privilege, plan or an included plan feature
// gives the same answer in the NestJS plugin as in the browser, with no code
// from the developer.
//
// The attributes come from the token BridgeAuthGuard verified (role,
// privileges, ids, plan claim) and from the workspace's `/session/init`
// snapshot (`bridge:billing.*`), flattened with the SAME auth-core functions
// the browser providers use — the key-set assertions compare against those
// functions, not against literals. Every test here fails if the request
// context goes back to `attributes: {}`.

import 'reflect-metadata';

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BridgePullCache,
  claimsToAttributes,
  flattenBillingSnapshot,
  serializeContext,
  type CachedFlag,
} from '@nebulr-group/bridge-auth-core';
import { lastValueFrom, of } from 'rxjs';

import { BridgeModule } from '../bridge.module';
import { BridgeService } from '../bridge/bridge.service';
import { rememberVerifiedUserToken } from '../bridge/verified-request';
import type { JwtClaims } from '../types/user';
import { BridgeFlagGuard } from './flag.guard';
import { FeatureNotInPlanException } from './feature-refusal';
import { BridgeContextInterceptor } from './flag.interceptor';
import { REQUIRE_FLAG_KEY } from './flag.decorator';
import { BridgeFlagsModule } from './flags.module';
import { BridgeFlagsService } from './flags.service';
import { BRIDGE_FLAG_ATTRIBUTE_SOURCE } from './flags.tokens';
import { resolvedFlagContext, verifiedFlagContext } from './request-context';

const API = 'http://bridge.test';
const APP = 'app-1';

const OFFLINE_OPTS = {
  apiBaseUrl: API,
  apiKey: 'test-key',
  appId: APP,
  realtime: { enabled: false },
  telemetry: { enabled: false },
};

type Snapshot = {
  tenant: {
    id: string;
    subscription: { plan: { slug: string; name: string }; status: string };
    entitlements: Record<string, boolean>;
  };
};

function snapshot(plan: string, entitlements: Record<string, boolean>, status = 'active'): Snapshot {
  return {
    tenant: { id: 'x', subscription: { plan: { slug: plan, name: plan }, status }, entitlements },
  };
}

function claims(over: Partial<JwtClaims> & { plan?: string } = {}): JwtClaims {
  return {
    sub: 'u1',
    tid: 't1',
    role: 'MEMBER',
    email: 'u1@acme.test',
    plan: 'free',
    privileges: ['USER_READ'],
    iat: 1_000,
    ...over,
  } as JwtClaims;
}

let tokenSeq = 0;
/** A request as BridgeAuthGuard leaves it: bridgeUser set, token + claims remembered. */
function verifiedRequest(c: JwtClaims, extra: Record<string, unknown> = {}): any {
  const req: any = { headers: {}, bridgeUser: { id: c.sub, role: c.role }, ...extra };
  rememberVerifiedUserToken(req, `token-${++tokenSeq}`, c);
  return req;
}

/** Stub fetch: answers `/session/init` per tenant from `byTenant`, counts calls. */
function installSessionFetch(byTenant: Record<string, Snapshot | 'fail'>) {
  const calls: string[] = [];
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init?: any) => {
    const auth: string = init?.headers?.Authorization ?? '';
    calls.push(`${url} ${auth}`);
    const tid = tokenTenant.get(auth.replace('Bearer ', '')) ?? '';
    const snap = byTenant[tid];
    if (!snap || snap === 'fail') return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => snap };
  }) as any);
  return { calls, spy };
}

// Which tenant each minted token belongs to (for the fetch stub).
const tokenTenant = new Map<string, string>();
function verifiedRequestFor(c: JwtClaims, extra: Record<string, unknown> = {}): any {
  const req = verifiedRequest(c, extra);
  tokenTenant.set(`token-${tokenSeq}`, String(c.tid));
  return req;
}

function newBridgeService(): BridgeService {
  return new BridgeService(
    { apiBaseUrl: API, appId: APP },
    new BridgePullCache({ ttlMs: 30_000 }),
    {} as any, // JwksService — fromRequest reuses the guard's verification
  );
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('TBP-757 — request context attributes come from the verified token', () => {
  it('fills the auth attributes exactly as auth-core maps them', () => {
    const c = claims({ role: 'ADMIN', privileges: ['USER_READ', 'BETA'] });
    const ctx = verifiedFlagContext(verifiedRequest(c));
    expect(ctx?.identity).toBe('u1');
    expect(ctx?.attributes).toEqual(claimsToAttributes(c as never));
    expect(ctx?.attributes['user.role']).toBe('ADMIN');
  });

  it('a forged x-bridge-context header, req.user.role or bridgeUser.role cannot change them', () => {
    const c = claims({ role: 'MEMBER', plan: 'free', privileges: ['USER_READ'] });
    const req = verifiedRequest(c, {
      headers: {
        'x-bridge-context': serializeContext({
          identity: 'u1',
          attributes: { 'user.role': 'OWNER', 'tenant.plan': 'enterprise', privileges: ['ADMIN_ALL'] },
        }),
      },
      user: { id: 'u1', role: 'OWNER', privileges: ['ADMIN_ALL'], plan: 'enterprise' },
      bridgeFlagsContext: { identity: 'u1', attributes: { 'user.role': 'OWNER' } },
    });
    req.bridgeUser.role = 'OWNER';
    req.bridgeUser.privileges = ['ADMIN_ALL'];

    const ctx = verifiedFlagContext(req);
    expect(ctx?.attributes).toEqual(claimsToAttributes(c as never));
    expect(ctx?.attributes['user.role']).toBe('MEMBER');
    expect(ctx?.attributes['tenant.plan']).toBe('free');
    expect(ctx?.attributes.privileges).toEqual(['USER_READ']);
  });

  it('a request with only app-auth req.user (no Bridge-verified token) gets identity but no attributes', () => {
    const ctx = verifiedFlagContext({ user: { id: 'u9', role: 'OWNER' } });
    expect(ctx).toEqual({ identity: 'u9', attributes: {} });
  });
});

describe('TBP-757 — workspace billing attributes', () => {
  it('the resolved key set is claimsToAttributes + flattenBillingSnapshot, with no quota keys', async () => {
    const snap = snapshot('pro', { export: true, sso: false }, 'trial');
    installSessionFetch({ t1: snap });
    const c = claims();
    const ctx = await resolvedFlagContext(verifiedRequestFor(c), newBridgeService());

    const expected = {
      ...claimsToAttributes(c as never),
      ...flattenBillingSnapshot({
        subscription: snap.tenant.subscription,
        entitlements: snap.tenant.entitlements,
      }),
    };
    expect(Object.keys(ctx!.attributes).sort()).toEqual(Object.keys(expected).sort());
    expect(ctx!.attributes).toEqual(expected);
    expect(ctx!.attributes['bridge:billing.entitlement.export']).toBe(true);
    expect(Object.keys(ctx!.attributes).some((k) => k.startsWith('bridge:billing.quota.'))).toBe(false);
  });

  it('fetches once per workspace across two users', async () => {
    const { calls } = installSessionFetch({ t1: snapshot('pro', { export: true }) });
    const bridge = newBridgeService();

    const a = await resolvedFlagContext(verifiedRequestFor(claims({ sub: 'alice' })), bridge);
    const b = await resolvedFlagContext(verifiedRequestFor(claims({ sub: 'bob' })), bridge);

    expect(calls.filter((c) => c.includes('/session/init'))).toHaveLength(1);
    expect(a!.attributes['bridge:billing.plan']).toBe('pro');
    expect(b!.attributes['bridge:billing.plan']).toBe('pro');
    expect(b!.attributes['user.id']).toBe('bob');
  });

  it('a newer token with a different plan claim refetches; an older one does not', async () => {
    const byTenant: Record<string, Snapshot> = { t1: snapshot('free', {}) };
    const { calls } = installSessionFetch(byTenant);
    const bridge = newBridgeService();
    const sessionCalls = () => calls.filter((c) => c.includes('/session/init')).length;

    const first = await resolvedFlagContext(
      verifiedRequestFor(claims({ sub: 'alice', plan: 'free', iat: 1_000 })),
      bridge,
    );
    expect(first!.attributes['bridge:billing.plan']).toBe('free');
    expect(sessionCalls()).toBe(1);

    // The workspace upgrades; bob signs in with a fresh token carrying it.
    byTenant.t1 = snapshot('pro', { export: true });
    const upgraded = await resolvedFlagContext(
      verifiedRequestFor(claims({ sub: 'bob', plan: 'pro', iat: 2_000 })),
      bridge,
    );
    expect(sessionCalls()).toBe(2);
    expect(upgraded!.attributes['bridge:billing.plan']).toBe('pro');
    expect(upgraded!.attributes['bridge:billing.entitlement.export']).toBe(true);

    // carol still holds an old token from before the upgrade: no eviction.
    await resolvedFlagContext(
      verifiedRequestFor(claims({ sub: 'carol', plan: 'free', iat: 1_500 })),
      bridge,
    );
    expect(sessionCalls()).toBe(2);
  });

  it('a newer token for a user already seen refetches (noteToken)', async () => {
    const { calls } = installSessionFetch({ t1: snapshot('pro', {}) });
    const bridge = newBridgeService();
    const sessionCalls = () => calls.filter((c) => c.includes('/session/init')).length;

    await resolvedFlagContext(verifiedRequestFor(claims({ iat: 1_000 })), bridge);
    await resolvedFlagContext(verifiedRequestFor(claims({ iat: 1_000 })), bridge);
    // Two different token strings for the same user, the second newer.
    expect(sessionCalls()).toBe(2);
    await resolvedFlagContext(verifiedRequestFor(claims({ iat: 3_000 })), bridge);
    expect(sessionCalls()).toBe(3);
  });

  it('degrades to the claims when Bridge cannot be reached', async () => {
    installSessionFetch({ t1: 'fail' });
    const c = claims({ role: 'ADMIN' });
    const ctx = await resolvedFlagContext(verifiedRequestFor(c), newBridgeService());
    expect(ctx!.attributes).toEqual(claimsToAttributes(c as never));
  });
});

// ── End to end through the flag guard ─────────────────────────────────────────

function ruleFlag(key: string, attribute: string, operator: 'eq' | 'contains', value: unknown): CachedFlag {
  return {
    key,
    state: 'on-with-rule',
    valueType: 'boolean',
    offValue: false,
    onValue: true,
    rule: {
      branches: [{ conditions: [{ attribute, operator, values: [value as never] }], returnValue: true }],
      otherwiseValue: false,
      rolloutPct: 100,
    },
  };
}

const FLAGS: CachedFlag[] = [
  ruleFlag('export_beta', 'bridge:billing.entitlement.export', 'eq', true),
  ruleFlag('beta_reports', 'privileges', 'contains', 'BETA'),
  ruleFlag('admin_tools', 'user.role', 'eq', 'ADMIN'),
];

function httpContext(req: any, key: string): ExecutionContext {
  const handler = function () {
    /* noop */
  };
  Reflect.defineMetadata(REQUIRE_FLAG_KEY, { key, defaultValue: false, options: {} }, handler);
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => undefined }),
    getHandler: () => handler,
    getClass: () => class Stub {},
  } as unknown as ExecutionContext;
}

async function verdict(guard: BridgeFlagGuard, req: any, key: string): Promise<'pass' | 'forbidden'> {
  try {
    return (await guard.canActivate(httpContext(req, key))) ? 'pass' : 'forbidden';
  } catch (err) {
    // TBP-756: a plan-gated refusal is a 402, a role/off one a 403 — both refuse.
    if (err instanceof ForbiddenException || err instanceof FeatureNotInPlanException) return 'forbidden';
    throw err;
  }
}

describe('TBP-757 — BridgeFlagGuard with BridgeModule (no wiring by the app)', () => {
  let moduleRef: TestingModule;
  let guard: BridgeFlagGuard;
  let interceptor: BridgeContextInterceptor;

  beforeEach(async () => {
    installSessionFetch({
      t1: snapshot('pro', { export: true }),
      t2: snapshot('free', { export: false }),
    });
    moduleRef = await Test.createTestingModule({
      imports: [BridgeModule.forRoot({ appId: APP, apiBaseUrl: API }), BridgeFlagsModule.forRoot(OFFLINE_OPTS)],
    }).compile();
    guard = moduleRef.get(BridgeFlagGuard);
    interceptor = moduleRef.get(BridgeContextInterceptor);
    moduleRef.get(BridgeFlagsService).hydrate(FLAGS);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('BridgeModule binds the attribute source to BridgeService', () => {
    expect(moduleRef.get(BRIDGE_FLAG_ATTRIBUTE_SOURCE)).toBe(moduleRef.get(BridgeService));
  });

  it('an included plan feature rule passes for a workspace that has it and fails for one that does not', async () => {
    expect(await verdict(guard, verifiedRequestFor(claims({ tid: 't1' })), 'export_beta')).toBe('pass');
    expect(await verdict(guard, verifiedRequestFor(claims({ tid: 't2', sub: 'u2' })), 'export_beta')).toBe(
      'forbidden',
    );
  });

  it('a privileges rule passes on the verified privilege and fails without it', async () => {
    expect(
      await verdict(guard, verifiedRequestFor(claims({ privileges: ['USER_READ', 'BETA'] })), 'beta_reports'),
    ).toBe('pass');
    expect(await verdict(guard, verifiedRequestFor(claims({ privileges: ['USER_READ'] })), 'beta_reports')).toBe(
      'forbidden',
    );
  });

  it('a role rule cannot be unlocked by a forged role on the request', async () => {
    const req = verifiedRequestFor(claims({ role: 'MEMBER' }), { user: { id: 'u1', role: 'ADMIN' } });
    req.bridgeUser.role = 'ADMIN';
    expect(await verdict(guard, req, 'admin_tools')).toBe('forbidden');
    expect(await verdict(guard, verifiedRequestFor(claims({ role: 'ADMIN' })), 'admin_tools')).toBe('pass');
  });

  it('the interceptor puts the same resolved context on the request', async () => {
    const req = verifiedRequestFor(claims({ tid: 't1' }));
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => undefined }),
      getHandler: () => () => undefined,
      getClass: () => class Stub {},
    } as unknown as ExecutionContext;
    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(null) }));
    expect(req.bridgeFlagsContext.attributes['bridge:billing.entitlement.export']).toBe(true);
    expect(req.bridgeFlagsContext.attributes['user.role']).toBe('MEMBER');
  });
});

describe('TBP-757 — flags module on its own still evaluates on the verified claims', () => {
  it('a privileges rule works with no BridgeModule loaded', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BridgeFlagsModule.forRoot(OFFLINE_OPTS)],
    }).compile();
    const service = moduleRef.get(BridgeFlagsService);
    service.hydrate(FLAGS);
    const guard = new BridgeFlagGuard(new Reflector(), service);
    expect(await verdict(guard, verifiedRequest(claims({ privileges: ['BETA'] })), 'beta_reports')).toBe('pass');
    expect(await verdict(guard, verifiedRequest(claims({ privileges: [] })), 'beta_reports')).toBe('forbidden');
    // No billing source → billing rules cannot pass.
    expect(await verdict(guard, verifiedRequest(claims()), 'export_beta')).toBe('forbidden');
    await moduleRef.close();
  });
});
