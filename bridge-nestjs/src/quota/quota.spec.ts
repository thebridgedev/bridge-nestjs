// TBP-704 — @RequireQuota / @SyncQuota / @RequireEntitlement and the plain
// BridgeQuotaService calls behind them.
//
// The interceptor is driven the way Nest drives it: a real module, the real
// BridgeService / TenantScope, an ExecutionContext for a real controller
// method, and a CallHandler standing in for the handler. Only the network is
// stubbed — global `fetch` plays bridge-api — so every assertion is on the
// requests that would actually reach Bridge.

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

import { Controller, Delete, ExecutionContext, HttpException, Post } from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { lastValueFrom, of, throwError } from 'rxjs';

import { BridgeModule, resolveBridgeConfig } from '../bridge.module';
import { rememberVerifiedUserToken } from '../bridge/verified-request';
import type { QuotaSnapshot } from '../bridge/tenant-scope';
import { RequireEntitlement, RequireQuota, SyncQuota } from './quota.decorators';
import { BridgeQuotaInterceptor } from './quota.interceptor';
import { BridgeQuotaService } from './quota.service';
import type { BridgeModuleConfig } from '../types/config';

const API = 'https://api.test';
const APP = 'app-1';
const TENANT = 'tenant-a';
const USER = 'user-a';

/** The app's own ticket store — what a gauge `current` counts. */
class TicketStore {
  count = 3;
  countFor(tenantId: string): number {
    this.seenTenants.push(tenantId);
    return this.count;
  }
  seenTenants: string[] = [];
}
const store = new TicketStore();

@Controller('tickets')
class TicketsController {
  readonly tickets = store;

  @Post()
  @RequireQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  create() {}

  @Delete(':id')
  @SyncQuota('tickets', { current: (t, self: TicketsController) => self.tickets.countFor(t.id) })
  remove() {}

  @Post('export')
  @RequireEntitlement('exports')
  @RequireQuota('exports')
  export() {}

  @Post('invite')
  @RequireQuota('users')
  invite() {}
}

@Controller('reports')
@RequireEntitlement('reports')
class ReportsController {
  @Post()
  @RequireQuota('reports')
  run() {}
}

// ── bridge-api stand-in ────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  body?: any;
  auth?: string;
}
let calls: Call[];
let quotas: Record<string, QuotaSnapshot | null | 'error'>;
let entitlements: Record<string, boolean>;

function snap(metric: string, used: number, limit: number, extra: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    metric,
    used,
    limit,
    remaining: limit - used,
    warningLevel: null,
    policy: 'hard',
    kind: 'counter',
    ...extra,
  };
}

function res(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const fetchMock = jest.fn(async (url: string, init: RequestInit = {}) => {
  const path = url.slice(API.length);
  const method = init.method ?? 'GET';
  const headers = (init.headers ?? {}) as Record<string, string>;
  calls.push({
    method,
    path,
    body: init.body ? JSON.parse(init.body as string) : undefined,
    auth: headers.Authorization,
  });
  const quota = path.match(/^\/usage\/quota\/(.+)$/);
  if (quota) {
    const q = quotas[decodeURIComponent(quota[1])];
    if (q === 'error') return res({}, 500);
    return q ? res(q) : res(null, 404);
  }
  if (path === '/session/init') {
    return res({
      app: { branding: { logo: '', name: '' } },
      tenant: { id: TENANT, name: 'A', subscription: { plan: { slug: 'pro', name: 'Pro' }, status: 'active' }, entitlements },
      user: { id: USER, role: 'OWNER', tenantId: TENANT },
    });
  }
  return res({});
});

const writes = () => calls.filter((c) => c.method !== 'GET');
const reads = (prefix: string) => calls.filter((c) => c.method === 'GET' && c.path.startsWith(prefix));

// ── Nest plumbing ──────────────────────────────────────────────────────────

let moduleRef: TestingModule;
let interceptor: BridgeQuotaInterceptor;

async function boot(config: BridgeModuleConfig = {}) {
  moduleRef = await Test.createTestingModule({
    imports: [BridgeModule.forRoot({ appId: APP, apiBaseUrl: API, ...config })],
    controllers: [TicketsController, ReportsController],
  }).compile();
  interceptor = moduleRef.get(BridgeQuotaInterceptor);
}

/** A request BridgeAuthGuard verified for `tenant`. */
function verifiedRequest(tenant = TENANT, headers: Record<string, string> = {}, token = `jwt-${tenant}`) {
  const req = { headers: { authorization: `Bearer ${token}`, ...headers } };
  rememberVerifiedUserToken(req, token, { sub: USER, tid: tenant } as any);
  return req;
}

function ctx(controller: Function, method: string, req: object, response = { statusCode: 201 }): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => (controller.prototype as any)[method],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => response }),
    getArgByIndex: () => undefined,
  } as unknown as ExecutionContext;
}

/** Run the interceptor around a handler; returns the handler's result or throws the refusal. */
async function run(
  controller: Function,
  method: string,
  req: object,
  opts: { status?: number; handler?: () => unknown; throws?: Error } = {},
) {
  const response = { statusCode: opts.status ?? 201 };
  const handler = jest.fn(() => {
    if (opts.throws) return throwError(() => opts.throws);
    return of(opts.handler ? opts.handler() : { ok: true });
  });
  const result = await lastValueFrom(
    interceptor.intercept(ctx(controller, method, req, response), { handle: handler }),
  );
  return { result, handler };
}

async function refusal(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (e) {
    return e as HttpException;
  }
  throw new Error('expected the request to be refused');
}

beforeEach(async () => {
  calls = [];
  quotas = {};
  entitlements = {};
  store.count = 3;
  store.seenTenants = [];
  fetchMock.mockClear();
  jest.spyOn(global, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);
  await boot();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await moduleRef.close();
});

// ── Counter mode ───────────────────────────────────────────────────────────

describe('@RequireQuota — counter (something that happened)', () => {
  beforeEach(() => {
    entitlements = { exports: true };
  });

  it('lets the request through under the limit and reports exactly one event after the 2xx', async () => {
    quotas.exports = snap('exports', 4, 5);
    const { handler } = await run(TicketsController, 'export', verifiedRequest());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(writes()).toEqual([
      expect.objectContaining({ method: 'POST', path: '/usage/ingest', body: expect.objectContaining({ metric: 'exports', value: 1 }) }),
    ]);
  });

  it('refuses at the limit with 402 QUOTA_EXCEEDED naming metric, numbers and where to upgrade', async () => {
    quotas.exports = snap('exports', 5, 5);
    const response = { statusCode: 201 };
    const handler = jest.fn(() => of({}));

    const err = await refusal(
      lastValueFrom(interceptor.intercept(ctx(TicketsController, 'export', verifiedRequest(), response), { handle: handler })),
    );

    expect(err.getStatus()).toBe(402);
    expect(err.getResponse()).toEqual({
      statusCode: 402,
      code: 'QUOTA_EXCEEDED',
      message: expect.any(String),
      metric: 'exports',
      used: 5,
      limit: 5,
      fix: '/subscription',
    });
    expect(handler).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('points `fix` at billing.manageRoute when configured', async () => {
    await moduleRef.close();
    await boot({ billing: { manageRoute: '/account/billing' } });
    quotas.exports = snap('exports', 9, 5);

    const err = await refusal(run(TicketsController, 'export', verifiedRequest()));

    expect((err.getResponse() as any).fix).toBe('/account/billing');
  });

  it('a metered quota never refuses, even far past its allowance — it bills', async () => {
    quotas.exports = snap('exports', 900, 5, { policy: 'metered' });
    const { handler } = await run(TicketsController, 'export', verifiedRequest());

    expect(handler).toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
  });

  it('a metric with no quota on the plan is unlimited, and still recorded', async () => {
    const { handler } = await run(TicketsController, 'export', verifiedRequest());
    expect(handler).toHaveBeenCalled();
    expect(writes().map((w) => w.path)).toEqual(['/usage/ingest']);
  });

  it('fails closed with 503 when the quota cannot be read', async () => {
    quotas.exports = 'error';
    const err = await refusal(run(TicketsController, 'export', verifiedRequest()));
    expect(err.getStatus()).toBe(503);
    expect(writes()).toEqual([]);
  });
});

// ── Report after 2xx only ──────────────────────────────────────────────────

describe('usage is recorded only after a 2xx', () => {
  beforeEach(() => {
    entitlements = { exports: true };
    quotas.exports = snap('exports', 1, 5);
    quotas.tickets = snap('tickets', 1, 5, { kind: 'gauge' });
  });

  it.each([400, 404, 409, 500, 503])('a handler that answers %i records nothing', async (status) => {
    await run(TicketsController, 'export', verifiedRequest(), { status });
    await run(TicketsController, 'create', verifiedRequest(), { status });
    await run(TicketsController, 'remove', verifiedRequest(), { status });
    expect(writes()).toEqual([]);
  });

  it('a handler that throws records nothing', async () => {
    await expect(
      run(TicketsController, 'export', verifiedRequest(), { throws: new Error('db down') }),
    ).rejects.toThrow('db down');
    await expect(
      run(TicketsController, 'create', verifiedRequest(), { throws: new HttpException('bad', 400) }),
    ).rejects.toThrow('bad');
    expect(writes()).toEqual([]);
  });

  it.each([200, 201, 204])('a %i records', async (status) => {
    await run(TicketsController, 'export', verifiedRequest(), { status });
    expect(writes()).toHaveLength(1);
  });
});

// ── Idempotency-Key ────────────────────────────────────────────────────────

describe('Idempotency-Key passthrough (counter mode)', () => {
  beforeEach(() => {
    entitlements = { exports: true };
    quotas.exports = snap('exports', 0, 100);
  });

  const keysSent = () => writes().map((w) => w.body.idempotencyKey as string);

  it('the same header sends the same key, so a retried export is one event', async () => {
    await run(TicketsController, 'export', verifiedRequest(TENANT, { 'idempotency-key': 'export-42' }));
    await run(TicketsController, 'export', verifiedRequest(TENANT, { 'idempotency-key': 'export-42' }));

    const [a, b] = keysSent();
    expect(a).toBe(b);
    expect(a).toMatch(/^idem-[0-9a-f]{64}$/);
  });

  it('different headers send different keys', async () => {
    await run(TicketsController, 'export', verifiedRequest(TENANT, { 'idempotency-key': 'export-42' }));
    await run(TicketsController, 'export', verifiedRequest(TENANT, { 'idempotency-key': 'export-43' }));
    const [a, b] = keysSent();
    expect(a).not.toBe(b);
  });

  it('is scoped to the verified tenant: another workspace reusing the key cannot swallow the event', async () => {
    await run(TicketsController, 'export', verifiedRequest('tenant-a', { 'idempotency-key': 'k' }));
    await run(TicketsController, 'export', verifiedRequest('tenant-b', { 'idempotency-key': 'k' }));
    const [a, b] = keysSent();
    expect(a).not.toBe(b);
    // The raw client value is never what reaches Bridge.
    expect(a).not.toBe('k');
  });

  it('without the header every request counts (a fresh key each time)', async () => {
    await run(TicketsController, 'export', verifiedRequest());
    await run(TicketsController, 'export', verifiedRequest());
    const [a, b] = keysSent();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it('a spoofed x-bridge-context header does not change the tenant the key is scoped to (TBP-671)', async () => {
    const spoof = JSON.stringify({ tenant: { id: 'tenant-b' }, identity: { sub: 'victim' } });
    await run(TicketsController, 'export', verifiedRequest('tenant-a', { 'idempotency-key': 'k', 'x-bridge-context': spoof }));
    await run(TicketsController, 'export', verifiedRequest('tenant-a', { 'idempotency-key': 'k' }));
    const [a, b] = keysSent();
    expect(a).toBe(b);
  });
});

// ── Gauge mode ─────────────────────────────────────────────────────────────

describe('@RequireQuota — gauge (something that exists)', () => {
  it("compares the app's own count, not Bridge's stored value", async () => {
    store.count = 5; // the app has 5 tickets …
    quotas.tickets = snap('tickets', 2, 5, { kind: 'gauge' }); // … Bridge last heard 2

    const err = await refusal(run(TicketsController, 'create', verifiedRequest()));

    expect(err.getStatus()).toBe(402);
    expect((err.getResponse() as any)).toMatchObject({ code: 'QUOTA_EXCEEDED', metric: 'tickets', used: 5, limit: 5 });
    expect(writes()).toEqual([]);
  });

  it('after the 2xx sets the gauge to the new count — one PUT, no counter event', async () => {
    quotas.tickets = snap('tickets', 3, 5, { kind: 'gauge' });
    await run(TicketsController, 'create', verifiedRequest(), {
      handler: () => {
        store.count += 1; // the handler created one
        return { id: 't4' };
      },
    });

    expect(writes()).toEqual([
      expect.objectContaining({ method: 'PUT', path: '/usage/gauge/tickets', body: { value: 4 } }),
    ]);
  });

  it('counts for the verified tenant and hands the controller instance to `current`', async () => {
    quotas.tickets = snap('tickets', 0, 5, { kind: 'gauge' });
    await run(TicketsController, 'create', verifiedRequest('tenant-z'));
    expect(store.seenTenants).toEqual(['tenant-z', 'tenant-z']);
  });

  it('a metered policy never refuses, whatever the count', async () => {
    store.count = 50;
    quotas.tickets = snap('tickets', 50, 5, { kind: 'gauge', policy: 'metered' });
    const { handler } = await run(TicketsController, 'create', verifiedRequest());
    expect(handler).toHaveBeenCalled();
  });

  it('a gauge write that fails does not fail the response (the next create/delete heals it)', async () => {
    quotas.tickets = snap('tickets', 0, 5, { kind: 'gauge' });
    fetchMock.mockImplementationOnce(fetchMock.getMockImplementation()!); // quota GET
    fetchMock.mockImplementationOnce(async () => res({}, 500)); // gauge PUT
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { result } = await run(TicketsController, 'create', verifiedRequest());

    expect(result).toEqual({ ok: true });
    expect(warn).toHaveBeenCalled();
  });

  it('seats (`users`, a gauge Bridge keeps) are checked but never reported as counter events', async () => {
    quotas.users = snap('users', 2, 5, { kind: 'gauge' });
    await run(TicketsController, 'invite', verifiedRequest());
    expect(writes()).toEqual([]);

    quotas.users = snap('users', 5, 5, { kind: 'gauge' });
    const err = await refusal(run(TicketsController, 'invite', verifiedRequest()));
    expect(err.getStatus()).toBe(402);
  });
});

describe('@SyncQuota', () => {
  it('never checks the limit, and after the 2xx sets the gauge to the lower count', async () => {
    quotas.tickets = snap('tickets', 5, 5, { kind: 'gauge' }); // at the cap: a delete must still work
    store.count = 5;
    await run(TicketsController, 'remove', verifiedRequest(), {
      status: 200,
      handler: () => {
        store.count -= 1;
        return {};
      },
    });

    expect(reads('/usage/quota')).toEqual([]);
    expect(writes()).toEqual([
      expect.objectContaining({ method: 'PUT', path: '/usage/gauge/tickets', body: { value: 4 } }),
    ]);
  });
});

// ── Entitlements ───────────────────────────────────────────────────────────

describe('@RequireEntitlement', () => {
  it('refuses with 403 ENTITLEMENT_REQUIRED before the quota is even read', async () => {
    entitlements = { exports: false };
    quotas.exports = snap('exports', 0, 5);
    const response = { statusCode: 201 };
    const handler = jest.fn(() => of({}));

    const err = await refusal(
      lastValueFrom(interceptor.intercept(ctx(TicketsController, 'export', verifiedRequest(), response), { handle: handler })),
    );

    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toEqual({
      statusCode: 403,
      code: 'ENTITLEMENT_REQUIRED',
      message: expect.any(String),
      entitlement: 'exports',
      fix: '/subscription',
    });
    expect(handler).not.toHaveBeenCalled();
    expect(reads('/usage/quota')).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('works on a whole controller, and the interceptor registered twice still records once', async () => {
    entitlements = { reports: true };
    quotas.reports = snap('reports', 0, 5);
    // Class-level @RequireEntitlement + method-level @RequireQuota each register it.
    const registered = [
      ...(Reflect.getMetadata(INTERCEPTORS_METADATA, ReportsController) ?? []),
      ...(Reflect.getMetadata(INTERCEPTORS_METADATA, ReportsController.prototype.run) ?? []),
    ];
    expect(registered).toEqual([BridgeQuotaInterceptor, BridgeQuotaInterceptor]);

    const req = verifiedRequest();
    const response = { statusCode: 201 };
    const context = ctx(ReportsController, 'run', req, response);
    const inner = { handle: () => of({ ran: true }) };
    const outer = { handle: () => interceptor.intercept(context, inner) };
    await lastValueFrom(interceptor.intercept(context, outer));

    expect(writes()).toHaveLength(1);
  });

  it('refuses a controller-level entitlement the tenant lacks', async () => {
    entitlements = {};
    const err = await refusal(run(ReportsController, 'run', verifiedRequest()));
    expect(err.getStatus()).toBe(403);
  });
});

// ── Identity ───────────────────────────────────────────────────────────────

describe('identity comes from the verified token only', () => {
  it('401 and nothing sent when BridgeAuthGuard verified no user on the request', async () => {
    quotas.exports = snap('exports', 0, 5);
    const unverified = () => ({ headers: { authorization: 'Bearer forged' } });

    for (const method of ['export', 'create']) {
      const err = await refusal(run(TicketsController, method, unverified(), { status: 201 }));
      expect(err.getStatus()).toBe(401);
    }
    // @SyncQuota gates nothing: the handler runs, and no gauge is written for
    // a workspace nobody verified.
    const { handler } = await run(TicketsController, 'remove', unverified(), { status: 200 });
    expect(handler).toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('calls Bridge with the verified token', async () => {
    entitlements = { exports: true };
    await run(TicketsController, 'export', verifiedRequest(TENANT, {}, 'the-verified-token'));
    expect(calls.every((c) => c.auth === 'Bearer the-verified-token')).toBe(true);
  });
});

// ── Plain service calls ────────────────────────────────────────────────────

describe('BridgeQuotaService — the same calls, without decorators', () => {
  let svc: BridgeQuotaService;
  beforeEach(() => {
    svc = moduleRef.get(BridgeQuotaService);
  });

  it('check() answers without refusing; assertQuota() refuses with the same 402', async () => {
    quotas.tickets = snap('tickets', 0, 2, { kind: 'gauge' });
    const req = verifiedRequest();
    await expect(svc.check(req, 'tickets', { current: 2 })).resolves.toMatchObject({ allowed: false, used: 2, limit: 2 });
    await expect(svc.check(req, 'tickets', { current: async () => 1 })).resolves.toMatchObject({ allowed: true });
    const err = await refusal(svc.assertQuota(req, 'tickets', { current: 2 }));
    expect(err.getStatus()).toBe(402);
  });

  it('record() makes exactly one write per call: PUT for a gauge, POST for a counter', async () => {
    const req = verifiedRequest();
    await svc.record(req, 'tickets', { current: 7 });
    await svc.record(req, 'exports', { idempotencyKey: 'x' });
    await svc.sync(req, 'tickets', () => 6);
    expect(writes().map((w) => `${w.method} ${w.path}`)).toEqual([
      'PUT /usage/gauge/tickets',
      'POST /usage/ingest',
      'PUT /usage/gauge/tickets',
    ]);
  });

  it('assertEntitlement() refuses with the same 403', async () => {
    const err = await refusal(svc.assertEntitlement(verifiedRequest(), 'nope'));
    expect(err.getStatus()).toBe(403);
  });
});

// ── Env defaults ───────────────────────────────────────────────────────────

describe('BridgeModule.forRoot() reads its settings from the environment when given none', () => {
  const env = { BRIDGE_APP_ID: 'env-app', BRIDGE_API_BASE_URL: 'https://env.api', BRIDGE_DEBUG: 'true' };

  it('fills appId, apiBaseUrl and debug from the environment', () => {
    expect(resolveBridgeConfig({}, env)).toMatchObject({ appId: 'env-app', apiBaseUrl: 'https://env.api', debug: true });
  });

  it('an explicit value wins over the environment, including debug: false', () => {
    expect(resolveBridgeConfig({ appId: 'mine', apiBaseUrl: 'https://mine', debug: false }, env)).toMatchObject({
      appId: 'mine',
      apiBaseUrl: 'https://mine',
      debug: false,
    });
  });

  it('keeps the rest of the config (guard, billing) untouched', () => {
    const cfg = resolveBridgeConfig({ guard: { global: true }, billing: { manageRoute: '/b' } }, env);
    expect(cfg.guard).toEqual({ global: true });
    expect(cfg.billing).toEqual({ manageRoute: '/b' });
  });

  it('refuses to start without an app id either way', () => {
    expect(() => resolveBridgeConfig({}, {})).toThrow(/BRIDGE_APP_ID/);
  });

  it('forRoot() with no arguments boots from the environment', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const m = await Test.createTestingModule({ imports: [BridgeModule.forRoot()] }).compile();
      const svc = m.get(BridgeQuotaService);
      expect(svc).toBeInstanceOf(BridgeQuotaService);
      await m.close();
    } finally {
      process.env = saved;
    }
  });
});


// ── TBP-697: dev-only "this endpoint counted <metric>" header ─────────────

describe('X-Bridge-Usage-Counted (outside production only) — TBP-697', () => {
  /** An Express-like response that keeps its headers. */
  function expressResponse(status = 201) {
    const headers = new Map<string, string>();
    return {
      statusCode: status,
      headers,
      setHeader: (name: string, value: string) => void headers.set(name.toLowerCase(), value),
      getHeader: (name: string) => headers.get(name.toLowerCase()),
    };
  }
  async function intercept(method: string, response: ReturnType<typeof expressResponse>) {
    return lastValueFrom(
      interceptor.intercept(ctx(TicketsController, method, verifiedRequest(), response as any), {
        handle: () => of({ ok: true }),
      }),
    );
  }
  const prevEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = prevEnv;
  });

  it('a counter endpoint names its metric on the 2xx and exposes the header to cross-origin pages', async () => {
    process.env.NODE_ENV = 'development';
    entitlements = { exports: true };
    quotas.exports = snap('exports', 1, 5);
    const response = expressResponse();
    await intercept('export', response);
    expect(response.headers.get('x-bridge-usage-counted')).toBe('exports');
    expect(response.headers.get('access-control-expose-headers')).toContain('X-Bridge-Usage-Counted');
  });

  it('a gauge endpoint (@RequireQuota with current) and @SyncQuota name theirs', async () => {
    process.env.NODE_ENV = 'test';
    quotas.tickets = snap('tickets', 1, 5, { kind: 'gauge' });
    const created = expressResponse();
    await intercept('create', created);
    expect(created.headers.get('x-bridge-usage-counted')).toBe('tickets');
    const removed = expressResponse(200);
    await intercept('remove', removed);
    expect(removed.headers.get('x-bridge-usage-counted')).toBe('tickets');
  });

  it('a 402 refusal carries it too (the browser sees the metric even at the cap)', async () => {
    process.env.NODE_ENV = 'development';
    entitlements = { exports: true };
    quotas.exports = snap('exports', 5, 5);
    const response = expressResponse();
    await refusal(intercept('export', response));
    expect(response.headers.get('x-bridge-usage-counted')).toBe('exports');
  });

  it('a gauge Bridge keeps (`users`) is only checked here, so it is not named', async () => {
    process.env.NODE_ENV = 'development';
    quotas.users = snap('users', 2, 5, { kind: 'gauge' });
    const response = expressResponse();
    await intercept('invite', response);
    expect(response.headers.has('x-bridge-usage-counted')).toBe(false);
  });

  it('merges with an Access-Control-Expose-Headers the app already set', async () => {
    process.env.NODE_ENV = 'development';
    entitlements = { exports: true };
    quotas.exports = snap('exports', 1, 5);
    const response = expressResponse();
    response.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
    await intercept('export', response);
    expect(response.headers.get('access-control-expose-headers')).toBe('X-Request-Id, X-Bridge-Usage-Counted');
  });

  it('NODE_ENV=production: no header at all — no production noise', async () => {
    process.env.NODE_ENV = 'production';
    entitlements = { exports: true };
    quotas.exports = snap('exports', 1, 5);
    const response = expressResponse();
    await intercept('export', response);
    expect(response.headers.size).toBe(0);
  });

  it('a Fastify reply (header()) works too', async () => {
    process.env.NODE_ENV = 'development';
    entitlements = { exports: true };
    quotas.exports = snap('exports', 1, 5);
    const headers = new Map<string, string>();
    const reply = {
      statusCode: 201,
      header: (n: string, v: string) => void headers.set(n.toLowerCase(), v),
      getHeader: (n: string) => headers.get(n.toLowerCase()),
    };
    await intercept('export', reply as any);
    expect(headers.get('x-bridge-usage-counted')).toBe('exports');
  });
});
