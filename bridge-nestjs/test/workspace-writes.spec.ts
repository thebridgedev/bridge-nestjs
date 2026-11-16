import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BridgeError, FlagSet, type Actor, type BridgeServer, type RequestLike } from '@nebulr-group/bridge-auth-core/server';
import { BridgeAuthGuard, Public, RequireFlag } from '../src';
import { BRIDGE_OPTIONS, BRIDGE_SERVER } from '../src/options';
import { featureRefusalBody } from '../src/flags/feature-refusal';

/**
 * How the guard answers what auth-core's check says about a write: a refused
 * write becomes an HttpException that carries the problem and its status,
 * never a 500; a read, a public route and an active, paid workspace pass.
 * auth-core is stood in for here, so these tests say nothing about what it
 * decides, only that the guard hands it the method and surfaces the answer.
 */

const actor: Actor = { kind: 'person', id: 'usr-1', personId: 'usr-1', workspaceId: 'ws-1', sessionId: 's-1', appId: 'app-1', standing: 'active' };

const notActive = new BridgeError('forbidden', 'This workspace is suspended; it can be read but not changed.', {
  status: 403,
  code: 'workspace-not-active',
  problem: { type: 'urn:bridge:problem:workspace-not-active', title: 'Workspace not active', status: 403, detail: 'This workspace is suspended.', standing: 'suspended' },
});
const locked = new BridgeError('plan-required', 'This workspace is locked for payment.', {
  status: 402,
  code: 'billing-locked',
  problem: { type: 'urn:bridge:problem:billing-locked', title: 'Payment required', status: 402, detail: 'Locked.', reason: 'billing_locked', billing: { access: 'payment_due' } },
});
const unknown = new BridgeError('unavailable', 'Payment state could not be read.', {
  status: 503,
  code: 'workspace-state-unavailable',
  problem: { type: 'urn:bridge:problem:unavailable', title: 'Service unavailable', status: 503, detail: 'Payment state could not be read.' },
});

@Controller()
class Things {
  @Get('things')
  list() {
    return { ok: true };
  }

  @Post('things')
  create() {
    return { ok: true };
  }

  @Public()
  @Post('public')
  open() {
    return { ok: true };
  }

  @RequireFlag('exports')
  @Get('exports')
  exports() {
    return { ok: true };
  }
}

describe('the guard and a write the workspace may not make', () => {
  let app: INestApplication;
  let answer: { ok: true; actor: Actor; flags?: FlagSet } | { ok: false; error: BridgeError };
  let seen: { method: string | undefined; strict: boolean | undefined }[];
  let flagReads: number;
  let flagSet: FlagSet;

  beforeEach(async () => {
    answer = { ok: true, actor };
    seen = [];
    flagReads = 0;
    flagSet = new FlagSet();
    const server = {
      check: async (checked: RequestLike, options: { strict?: boolean } = {}) => {
        seen.push({ method: checked.method, strict: options.strict });
        return answer;
      },
      flags: {
        forRequest: async () => {
          flagReads += 1;
          return flagSet;
        },
      },
    } as unknown as BridgeServer;
    const moduleRef = await Test.createTestingModule({
      controllers: [Things],
      providers: [
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

  const call = (method: 'get' | 'post', path: string) => request(app.getHttpServer())[method](path).set('authorization', 'Bearer a.b.c');

  it('hands the request method to the check', async () => {
    await call('get', '/things');
    await call('post', '/things');
    expect(seen.map((each) => each.method)).toEqual(['GET', 'POST']);
  });

  it('answers 403 with the workspace-not-active problem for a suspended workspace', async () => {
    answer = { ok: false, error: notActive };
    const refused = await call('post', '/things');
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ type: 'urn:bridge:problem:workspace-not-active', status: 403, standing: 'suspended' });
  });

  it('answers 402 with the billing-locked problem when the workspace is locked for payment', async () => {
    answer = { ok: false, error: locked };
    const refused = await call('post', '/things');
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({ type: 'urn:bridge:problem:billing-locked', reason: 'billing_locked', billing: { access: 'payment_due' } });
  });

  it('answers 503 with Retry-After, never 500, when the state cannot be told', async () => {
    answer = { ok: false, error: unknown };
    const refused = await call('post', '/things');
    expect(refused.status).toBe(503);
    expect(refused.headers['retry-after']).toBe('5');
    expect(refused.body).toMatchObject({ type: 'urn:bridge:problem:unavailable', status: 503 });
  });

  it('still answers 503 with the credential message when the credential itself cannot be checked', async () => {
    answer = { ok: false, error: new BridgeError('unavailable', 'down', { status: 503, code: 'unavailable' }) };
    const refused = await call('get', '/things');
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ message: 'Credentials cannot be checked right now; try again shortly.' });
  });

  it('lets a read and a write through when the check passes', async () => {
    expect((await call('get', '/things')).status).toBe(200);
    expect((await call('post', '/things')).status).toBe(201);
  });

  it('ignores a refusal on a public route, as it does any failed credential', async () => {
    answer = { ok: false, error: locked };
    expect((await call('post', '/public')).status).toBe(201);
  });

  it('reuses the flag results the check read, for the route\'s flag gate', async () => {
    flagSet = new FlagSet(new Map([['exports', { key: 'exports', value: false, reason: 'STATIC' }]]));
    answer = { ok: true, actor, flags: new FlagSet(new Map([['exports', { key: 'exports', value: true, reason: 'STATIC' }]])) };
    expect((await call('get', '/exports')).status).toBe(200);
    expect(flagReads).toBe(0);
    answer = { ok: true, actor };
    expect((await call('get', '/exports')).status).toBe(403);
    expect(flagReads).toBe(1);
  });
});

describe('a flag gate that is off because of the plan', () => {
  const off = (metadata: Record<string, unknown>) => new FlagSet(new Map([['exports', { key: 'exports', value: false, reason: 'TARGETING_MATCH', metadata }]]));

  it('answers 402 with the plan feature named, as a problem', () => {
    expect(featureRefusalBody(off({ why: 'plan', entitlement: 'exports' }), 'exports')).toMatchObject({
      statusCode: 402,
      code: 'FEATURE_NOT_IN_PLAN',
      type: 'urn:bridge:problem:entitlement-missing',
      status: 402,
      feature: 'exports',
      entitlement: 'exports',
      fix: '/subscription',
    });
  });

  it('answers 402 for a plan limit that has nothing left, with the numbers when Bridge gives them', () => {
    expect(featureRefusalBody(off({ why: 'plan', metric: 'seats', limit: 5, used: 5 }), 'exports')).toMatchObject({
      statusCode: 402,
      type: 'urn:bridge:problem:limit-reached',
      reason: 'limit_reached',
      metric: 'seats',
      limit: 5,
      used: 5,
    });
    const bare = featureRefusalBody(off({ why: 'plan' }), 'exports');
    expect(bare).toMatchObject({ statusCode: 402, type: 'urn:bridge:problem:limit-reached' });
    expect(bare.entitlement).toBeUndefined();
  });

  it('keeps 403 for every other reason', () => {
    expect(featureRefusalBody(off({ why: 'privilege' }), 'exports')).toMatchObject({ statusCode: 403, code: 'FEATURE_OFF' });
    expect(featureRefusalBody(new FlagSet(), 'exports')).toMatchObject({ statusCode: 403, code: 'FEATURE_OFF' });
  });
});
