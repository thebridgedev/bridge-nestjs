import { Controller, Delete, Get, HttpCode, INestApplication, Post, Res } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BridgeError, FlagSet, type Actor, type BridgeServer, type QuotaSnapshot } from '@nebulr-group/bridge-auth-core/server';
import { BridgeAuthGuard, BridgeQuotaInterceptor, BridgeQuotaService, BridgeService, QuotaExceededException, RequireEntitlement, RequireQuota, SyncQuota, USAGE_COUNTED_HEADER } from '../src';
import { BRIDGE_OPTIONS, BRIDGE_SERVER } from '../src/options';
import { setBridgeState } from '../src/request-context';

/**
 * @RequireQuota, @SyncQuota and @RequireEntitlement, with auth-core's server
 * stood in for: these tests say what the decorators ask of it and how they
 * answer, not what Bridge decides.
 */

const actor: Actor = { kind: 'person', id: 'usr-1', personId: 'usr-1', workspaceId: 'ws-1', sessionId: 's-1', appId: 'app-1', standing: 'active' };

const limitReached = new BridgeError('plan-required', 'Your plan allows 3 tickets; 3 are in use.', {
  status: 402,
  code: 'limit-reached',
  quota: { metric: 'tickets', limit: 3, used: 3 },
});
const locked = new BridgeError('plan-required', 'Locked.', { status: 402, code: 'billing-locked' });

let order: string[];
let created = 0;
let countNow = 2;

@Controller()
class Tickets {
  @Post('tickets')
  @RequireQuota('tickets', { current: () => countNow })
  create() {
    order.push('handler');
    created += 1;
    return { ok: true };
  }

  @Post('exports')
  @RequireQuota('exports')
  runExport() {
    order.push('handler');
    return { ok: true };
  }

  @Post('exports-fails')
  @RequireQuota('exports')
  fails(): never {
    order.push('handler');
    throw new Error('boom');
  }

  @Post('exports-4xx')
  @RequireQuota('exports')
  @HttpCode(200)
  badRequest(@Res({ passthrough: true }) res: { status(code: number): void }) {
    order.push('handler');
    res.status(422);
    return { ok: false };
  }

  @Delete('tickets/:id')
  @SyncQuota('tickets', { current: (t, self: Tickets) => (self instanceof Tickets && t.id === 'ws-1' && t.userId === 'usr-1' ? countNow : -5) })
  remove() {
    order.push('handler');
    return { ok: true };
  }

  @Get('analytics')
  @RequireEntitlement('analytics')
  analytics() {
    return { ok: true };
  }
}

describe('plan limit decorators', () => {
  let app: INestApplication;
  let flagSet: FlagSet;
  let flagError: Error | null;
  let hold: jest.Mock;
  let confirm: jest.Mock;
  let giveBack: jest.Mock;
  let set: jest.Mock;
  let counted: jest.Mock;
  let snapshot: QuotaSnapshot | null;

  beforeEach(async () => {
    order = [];
    created = 0;
    countNow = 2;
    flagSet = new FlagSet();
    flagError = null;
    snapshot = null;
    confirm = jest.fn(async () => {
      order.push('confirm');
    });
    giveBack = jest.fn(async () => {
      order.push('giveBack');
    });
    hold = jest.fn(async (_actor: Actor, metric: string) => {
      order.push('hold');
      return { id: 'h-1', metric, limit: 3, used: 1, expiresInSeconds: 120, confirm, giveBack };
    });
    set = jest.fn(() => {
      order.push('set');
    });
    counted = jest.fn();
    const server = {
      check: async () => ({ ok: true, actor }),
      close: async () => undefined,
      flags: {
        forRequest: async () => {
          if (flagError !== null) throw flagError;
          return flagSet;
        },
      },
      usage: { hold, set, count: counted, quota: async () => snapshot },
    } as unknown as BridgeServer;
    const moduleRef = await Test.createTestingModule({
      controllers: [Tickets],
      providers: [
        BridgeService,
        BridgeQuotaService,
        BridgeQuotaInterceptor,
        BridgeAuthGuard,
        { provide: BRIDGE_OPTIONS, useValue: {} },
        { provide: BRIDGE_SERVER, useValue: server },
        { provide: APP_GUARD, useExisting: BridgeAuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const call = (method: 'get' | 'post' | 'delete', path: string) => request(app.getHttpServer())[method](path).set('authorization', 'Bearer a.b.c');

  describe('@RequireQuota', () => {
    it('holds a unit before the handler and confirms it once the handler answered 2xx', async () => {
      const answer = await call('post', '/exports');
      expect(answer.status).toBe(201);
      expect(order).toEqual(['hold', 'handler', 'confirm']);
      expect(hold).toHaveBeenCalledWith(actor, 'exports', { decision: expect.stringMatching(/^hold-/) });
      expect(giveBack).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    });

    it('refuses 402 QUOTA_EXCEEDED with the 0.9 body when the limit is reached, and never runs the handler', async () => {
      hold.mockRejectedValueOnce(limitReached);
      const answer = await call('post', '/exports');
      expect(answer.status).toBe(402);
      expect(answer.body).toEqual({
        statusCode: 402,
        code: 'QUOTA_EXCEEDED',
        message: 'Your plan allows 3 tickets; 3 are in use.',
        metric: 'tickets',
        used: 3,
        limit: 3,
        fix: '/subscription',
      });
      expect(order).toEqual([]);
    });

    it('names the module\'s manageRoute in `fix`', async () => {
      await app.close();
      const server = { check: async () => ({ ok: true, actor }), close: async () => undefined, flags: { forRequest: async () => flagSet }, usage: { hold: async () => { throw limitReached; } } } as unknown as BridgeServer;
      const moduleRef = await Test.createTestingModule({
        controllers: [Tickets],
        providers: [BridgeService, BridgeQuotaService, BridgeQuotaInterceptor, BridgeAuthGuard, { provide: BRIDGE_OPTIONS, useValue: { manageRoute: '/billing' } }, { provide: BRIDGE_SERVER, useValue: server }, { provide: APP_GUARD, useExisting: BridgeAuthGuard }],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
      expect((await call('post', '/exports')).body).toMatchObject({ code: 'QUOTA_EXCEEDED', fix: '/billing' });
    });

    it('answers a locked workspace 402 BILLING_GATE_ENGAGED, as 0.9 did', async () => {
      hold.mockRejectedValueOnce(locked);
      const answer = await call('post', '/exports');
      expect(answer.status).toBe(402);
      expect(answer.body).toMatchObject({ statusCode: 402, code: 'BILLING_GATE_ENGAGED', reason: 'billing_locked', billing: { gateEngaged: true, recoveryUrl: '/subscription' } });
      expect(order).toEqual([]);
    });

    it('refuses 503 QUOTA_UNAVAILABLE when Bridge cannot be asked (fail closed)', async () => {
      hold.mockRejectedValueOnce(new BridgeError('unavailable', 'down', { status: 503 }));
      const answer = await call('post', '/exports');
      expect(answer.status).toBe(503);
      expect(answer.body).toMatchObject({ code: 'QUOTA_UNAVAILABLE', metric: 'exports' });
      expect(order).toEqual([]);
    });

    it('gives the unit back when the handler throws, and the error reaches the caller', async () => {
      const answer = await call('post', '/exports-fails');
      expect(answer.status).toBe(500);
      expect(order).toEqual(['hold', 'handler', 'giveBack']);
      expect(confirm).not.toHaveBeenCalled();
    });

    it('gives the unit back when the handler answers 4xx itself', async () => {
      const answer = await call('post', '/exports-4xx');
      expect(answer.status).toBe(422);
      expect(order).toEqual(['hold', 'handler', 'giveBack']);
    });

    it('counts the unit from a report, once, when confirming finds the hold gone, and never fails the response', async () => {
      confirm.mockRejectedValueOnce(new BridgeError('not-found', 'Not found', { status: 404 }));
      const answer = await call('post', '/exports');
      expect(answer.status).toBe(201);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(counted).toHaveBeenCalledTimes(1);
      const [, metric, value, options] = counted.mock.calls[0] as [Actor, string, number, { id: string }];
      expect([metric, value]).toEqual(['exports', 1]);
      // A one-time id of the hold: sent again, it counts once.
      const req = {};
      setBridgeState(req, { actor, flags: async () => flagSet });
      expect(options.id).toBe(app.get(BridgeQuotaService).idempotencyKeyFor(req, 'exports', 'hold-h-1'));
    });

    it('asks a confirm again while Bridge does not answer (Bridge counts it once), and counts the unit from a report if it never does', async () => {
      confirm.mockRejectedValueOnce(new BridgeError('unavailable', 'down', { status: 503 }));
      expect((await call('post', '/exports')).status).toBe(201);
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(counted).not.toHaveBeenCalled();
      confirm.mockReset();
      confirm.mockRejectedValue(new BridgeError('unavailable', 'down', { status: 503 }));
      expect((await call('post', '/exports')).status).toBe(201);
      expect(confirm).toHaveBeenCalledTimes(3);
      expect(counted).toHaveBeenCalledTimes(1);
    });

    it('never counts an unconfirmed gauge from a report: its count sets it', async () => {
      snapshot = { metric: 'exports', used: 1, limit: 3, remaining: 2, percent_used: 0.33, policy: 'hard', kind: 'gauge', warningLevel: null, label: 'exports' };
      confirm.mockRejectedValueOnce(new BridgeError('not-found', 'Not found', { status: 404 }));
      expect((await call('post', '/exports')).status).toBe(201);
      expect(counted).not.toHaveBeenCalled();
    });

    it('holds every request with a new decision made on the server, never from the client\'s Idempotency-Key', async () => {
      await call('post', '/exports').set('idempotency-key', 'abc-123');
      await call('post', '/exports').set('idempotency-key', 'abc-123');
      const [first, second] = hold.mock.calls.map((each) => (each[2] as { decision: string }).decision);
      expect(first).toMatch(/^hold-[0-9a-f-]{36}$/);
      expect(second).toMatch(/^hold-[0-9a-f-]{36}$/);
      expect(first).not.toBe(second);
      expect(`${first}${second}`).not.toContain('abc-123');
    });

    it('names the metric the endpoint counts on the response outside production, on a 402 too', async () => {
      const answer = await call('post', '/exports');
      expect(answer.headers[USAGE_COUNTED_HEADER.toLowerCase()]).toBe('exports');
      expect(answer.headers['access-control-expose-headers']).toContain(USAGE_COUNTED_HEADER);
      hold.mockRejectedValueOnce(locked);
      expect((await call('post', '/exports')).headers[USAGE_COUNTED_HEADER.toLowerCase()]).toBe('exports');
      const was = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        expect((await call('post', '/exports')).headers[USAGE_COUNTED_HEADER.toLowerCase()]).toBeUndefined();
      } finally {
        process.env.NODE_ENV = was;
      }
    });

    it('in gauge mode sets the gauge to the handler\'s count after a 2xx, once the unit is confirmed', async () => {
      countNow = 3;
      const answer = await call('post', '/tickets');
      expect(answer.status).toBe(201);
      expect(order).toEqual(['hold', 'handler', 'confirm', 'set']);
      expect(set).toHaveBeenCalledWith(actor, 'tickets', 3);
    });

    it('in gauge mode sets nothing when the limit refuses', async () => {
      hold.mockRejectedValueOnce(limitReached);
      expect((await call('post', '/tickets')).status).toBe(402);
      expect(set).not.toHaveBeenCalled();
      expect(created).toBe(0);
    });

    it('answers 401 when no workspace user was verified', async () => {
      const answer = await request(app.getHttpServer()).post('/exports');
      expect(answer.status).toBe(401);
      expect(hold).not.toHaveBeenCalled();
    });
  });

  describe('@SyncQuota', () => {
    it('sets the gauge to the count after a 2xx and holds nothing', async () => {
      countNow = 4;
      const answer = await call('delete', '/tickets/1');
      expect(answer.status).toBe(200);
      expect(order).toEqual(['handler', 'set']);
      expect(set).toHaveBeenCalledWith(actor, 'tickets', 4);
      expect(hold).not.toHaveBeenCalled();
    });

    it('rejects a count that is not a whole number, without failing the response', async () => {
      countNow = -1;
      expect((await call('delete', '/tickets/1')).status).toBe(200);
      expect(set).not.toHaveBeenCalled();
    });

    it('needs a count function', () => {
      expect(() => SyncQuota('tickets', {} as never)).toThrow(TypeError);
      expect(() => RequireQuota('')).toThrow(TypeError);
      expect(() => RequireEntitlement('')).toThrow(TypeError);
    });
  });

  describe('@RequireEntitlement', () => {
    it('lets the call through when the flag bridge:billing.entitlement.<key> is on', async () => {
      flagSet = new FlagSet(new Map([['bridge:billing.entitlement.analytics', { key: 'bridge:billing.entitlement.analytics', value: true, reason: 'STATIC' }]]));
      expect((await call('get', '/analytics')).status).toBe(200);
    });

    it('refuses 403 ENTITLEMENT_REQUIRED with the 0.9 body when the flag is off, never reading the plan', async () => {
      const answer = await call('get', '/analytics');
      expect(answer.status).toBe(403);
      expect(answer.body).toEqual({
        statusCode: 403,
        code: 'ENTITLEMENT_REQUIRED',
        message: "Your plan does not include 'analytics'.",
        entitlement: 'analytics',
        fix: '/subscription',
      });
    });

    it('refuses 503 ENTITLEMENT_UNAVAILABLE when the flags cannot be read (fail closed)', async () => {
      flagError = new Error('down');
      const answer = await call('get', '/analytics');
      expect(answer.status).toBe(503);
      expect(answer.body).toMatchObject({ code: 'ENTITLEMENT_UNAVAILABLE', entitlement: 'analytics' });
    });
  });

  describe('BridgeQuotaService', () => {
    const asked = (): { quota: BridgeQuotaService; req: object } => {
      const req = {};
      setBridgeState(req, { actor, flags: async () => flagSet });
      return { quota: app.get(BridgeQuotaService), req };
    };
    const snap = (over: Partial<QuotaSnapshot>): QuotaSnapshot => ({ metric: 'tickets', used: 2, limit: 3, remaining: 1, percent_used: 0.66, policy: 'hard', kind: 'gauge', warningLevel: null, label: 'tickets', ...over });

    it('allows a metric the plan sets no quota for', async () => {
      const { quota, req } = asked();
      expect(await quota.check(req, 'tickets')).toEqual({ allowed: true, metric: 'tickets', used: 0, limit: null, quota: null });
    });

    it('allows a metered quota past its limit', async () => {
      snapshot = snap({ policy: 'metered', used: 9 });
      const { quota, req } = asked();
      expect((await quota.check(req, 'tickets')).allowed).toBe(true);
    });

    it('compares Bridge\'s count, or your own in gauge mode, with a hard limit', async () => {
      snapshot = snap({ used: 2 });
      const { quota, req } = asked();
      expect((await quota.check(req, 'tickets')).allowed).toBe(true);
      expect(await quota.check(req, 'tickets', { current: 3 })).toMatchObject({ allowed: false, used: 3, limit: 3 });
      await expect(quota.assertQuota(req, 'tickets', { current: () => 3 })).rejects.toBeInstanceOf(QuotaExceededException);
    });

    it('answers 503 when the quota cannot be read', async () => {
      const { quota, req } = asked();
      (app.get(BRIDGE_SERVER) as unknown as { usage: { quota: unknown } }).usage.quota = async () => {
        throw new Error('down');
      };
      await expect(quota.check(req, 'tickets')).rejects.toMatchObject({ status: 503 });
    });

    it('counts a counter once per idempotency key, scoped to the workspace and metric', async () => {
      const { quota, req } = asked();
      await quota.record(req, 'exports', { value: 2, idempotencyKey: 'k1' });
      const id = counted.mock.calls[0][3].id as string;
      expect(counted).toHaveBeenCalledWith(actor, 'exports', 2, { id });
      expect(id).toBe(quota.idempotencyKeyFor(req, 'exports', 'k1'));
      expect(id).not.toBe(quota.idempotencyKeyFor(req, 'other', 'k1'));
    });

    it('sets a gauge from a count function, and never throws when the count is wrong', async () => {
      const { quota, req } = asked();
      await quota.sync(req, 'tickets', async () => 7);
      expect(set).toHaveBeenCalledWith(actor, 'tickets', 7);
      await expect(quota.sync(req, 'tickets', () => 1.5)).resolves.toBeUndefined();
    });

    it('does not record, and does not throw, with no verified caller', async () => {
      await expect(app.get(BridgeQuotaService).record({}, 'exports')).resolves.toBeUndefined();
      expect(counted).not.toHaveBeenCalled();
    });

    it('holds with the options it is given', async () => {
      const { quota, req } = asked();
      const held = await quota.hold(req, 'seats', { quantity: 2 });
      expect(held.metric).toBe('seats');
      expect(hold).toHaveBeenCalledWith(actor, 'seats', { quantity: 2, decision: expect.stringMatching(/^hold-/) });
    });
  });
});
