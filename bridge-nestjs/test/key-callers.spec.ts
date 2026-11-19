import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BridgeError, FlagSet, type Actor, type BridgeServer, type RequestLike } from '@nebulr-group/bridge-auth-core/server';
import { BridgeAuthGuard, Public, RequireFlag } from '../src';
import { BRIDGE_OPTIONS, BRIDGE_SERVER, type BridgeModuleOptions } from '../src/options';

/**
 * How the guard treats a caller that came with a key. A key is evaluated for
 * its flag gates like a person (Bridge answers for the key, here a stand-in
 * does), and a key is refused on a route no flag gates unless the route is
 * open. A person's requests are the same on every route.
 */

const person: Actor = { kind: 'person', id: 'usr-1', personId: 'usr-1', workspaceId: 'ws-1', sessionId: 's-1', appId: 'app-1', standing: 'active' };
const key = (kind: 'service_account_key' | 'personal_key' | 'app_key'): Actor => ({ kind, id: `${kind}-1`, workspaceId: 'ws-1', appId: 'app-1', standing: 'active' }) as Actor;

/** The privilege `exports` asks for is held by `key-with` and by the person, not by `key-without`. */
const HOLDS = new Set(['key-with', 'Bearer person-token']);

@Controller()
class Things {
  @Get('plain')
  plain() {
    return { ok: true };
  }

  @Post('plain')
  plainWrite() {
    return { ok: true };
  }

  @Public()
  @Get('open')
  open() {
    return { ok: true };
  }

  @RequireFlag('exports')
  @Get('exports')
  exports() {
    return { ok: true };
  }

  @RequireFlag('exports')
  @Post('exports')
  exportsWrite() {
    return { ok: true };
  }

  @Get('by-rule-gated')
  byRuleGated() {
    return { ok: true };
  }

  @Get('by-rule-open')
  byRuleOpen() {
    return { ok: true };
  }

  @Get('by-rule-authenticated')
  byRuleAuthenticated() {
    return { ok: true };
  }
}

async function appWith(options: BridgeModuleOptions, seen: { forRequest: RequestLike[] }): Promise<INestApplication> {
  const server = {
    check: async (checked: RequestLike) => {
      const headers = checked.headers as Record<string, string | undefined>;
      const apiKey = headers['x-api-key'];
      const bearer = headers['authorization'];
      if (bearer === 'Bearer person-token') return { ok: true, actor: person };
      if (apiKey === 'key-with' || apiKey === 'key-without') return { ok: true, actor: key('service_account_key') };
      if (apiKey === 'app-key') return { ok: true, actor: key('app_key') };
      if (apiKey === 'personal-key') return { ok: true, actor: key('personal_key') };
      return { ok: false, error: new BridgeError('signed-out', 'No.', { status: 401, code: 'invalid_token' }) };
    },
    flags: {
      // Bridge answers for the caller whose credential came; what it decides is the flag's rule, which these stand in for.
      forRequest: async (checked: RequestLike) => {
        seen.forRequest.push(checked);
        const headers = checked.headers as Record<string, string | undefined>;
        const credential = headers['x-api-key'] ?? headers['authorization'];
        return new FlagSet(new Map([['exports', { key: 'exports', value: HOLDS.has(String(credential)), reason: 'TARGETING_MATCH' }]]));
      },
    },
  } as unknown as BridgeServer;
  const moduleRef = await Test.createTestingModule({
    controllers: [Things],
    providers: [
      BridgeAuthGuard,
      { provide: BRIDGE_OPTIONS, useValue: options },
      { provide: BRIDGE_SERVER, useValue: server },
      { provide: APP_GUARD, useExisting: BridgeAuthGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

describe('the guard and a caller that came with a key', () => {
  let app: INestApplication;
  let seen: { forRequest: RequestLike[] };

  beforeEach(async () => {
    seen = { forRequest: [] };
    app = await appWith({} as BridgeModuleOptions, seen);
  });

  afterEach(async () => {
    await app.close();
  });

  const asKey = (method: 'get' | 'post', path: string, apiKey: string) => request(app.getHttpServer())[method](path).set('x-api-key', apiKey);
  const asPerson = (method: 'get' | 'post', path: string) => request(app.getHttpServer())[method](path).set('authorization', 'Bearer person-token');

  describe('a flag-gated route', () => {
    it('lets a key through when its privileges match the flag\'s rule', async () => {
      expect((await asKey('get', '/exports', 'key-with')).status).toBe(200);
      expect((await asKey('post', '/exports', 'key-with')).status).toBe(201);
    });

    it('reads the flags for the key, with the key and nothing else', async () => {
      await asKey('get', '/exports', 'key-with').set('authorization', 'Bearer person-token');
      // Both came: the person's token decides, as before.
      expect(seen.forRequest[0]?.headers).toEqual({ authorization: 'Bearer person-token' });
      seen.forRequest = [];
      await asKey('get', '/exports', 'key-with');
      expect(seen.forRequest).toHaveLength(1);
      expect(seen.forRequest[0]?.headers).toEqual({ 'x-api-key': 'key-with' });
    });

    it('refuses a key whose privileges do not match with 403 FEATURE_OFF', async () => {
      const refused = await asKey('get', '/exports', 'key-without');
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ statusCode: 403, code: 'FEATURE_OFF' });
      expect((await asKey('post', '/exports', 'key-without')).status).toBe(403);
    });

    it.each(['personal-key', 'app-key'])('refuses a %s the flag is off for', async (apiKey) => {
      expect((await asKey('get', '/exports', apiKey)).status).toBe(403);
    });

    it('refuses a key that does not check out with 401, before any flag is read', async () => {
      expect((await asKey('get', '/exports', 'forged')).status).toBe(401);
      expect(seen.forRequest).toHaveLength(0);
    });
  });

  describe('a route with no flag gate', () => {
    it('refuses a key with 403 KEY_ROUTE_NOT_OPEN, on a read and a write', async () => {
      for (const [method, apiKey] of [['get', 'key-with'], ['post', 'key-with'], ['get', 'key-without'], ['get', 'app-key'], ['get', 'personal-key']] as const) {
        const refused = await asKey(method, '/plain', apiKey);
        expect(refused.status).toBe(403);
        expect(refused.body).toMatchObject({ statusCode: 403, code: 'KEY_ROUTE_NOT_OPEN' });
        expect(refused.body.message).toContain('@Public()');
      }
      expect(seen.forRequest).toHaveLength(0);
    });

    it('lets a key through on a route marked open with @Public()', async () => {
      expect((await asKey('get', '/open', 'key-without')).status).toBe(200);
    });

    it('lets a request with a credential that does not check out through a public route as anonymous', async () => {
      expect((await asKey('get', '/open', 'forged')).status).toBe(200);
    });

    it('still gives a request with no credential 401 on it', async () => {
      expect((await request(app.getHttpServer()).get('/plain')).status).toBe(401);
    });
  });

  describe('a person, on every one of these', () => {
    it('is unchanged on a gated route: through when the flag is on', async () => {
      expect((await asPerson('get', '/exports')).status).toBe(200);
      expect((await asPerson('post', '/exports')).status).toBe(201);
    });

    it('is unchanged on a route with no flag gate: through', async () => {
      expect((await asPerson('get', '/plain')).status).toBe(200);
      expect((await asPerson('post', '/plain')).status).toBe(201);
    });

    it('is unchanged on an open route: through', async () => {
      expect((await asPerson('get', '/open')).status).toBe(200);
    });
  });
});

describe('a gate that is off', () => {
  it('refuses a person 403 as before, and a key the same way', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [Things],
      providers: [
        BridgeAuthGuard,
        { provide: BRIDGE_OPTIONS, useValue: {} },
        {
          provide: BRIDGE_SERVER,
          useValue: {
            check: async (checked: RequestLike) => ({ ok: true, actor: (checked.headers as Record<string, string | undefined>)['x-api-key'] === undefined ? person : key('service_account_key') }),
            flags: { forRequest: async () => new FlagSet(new Map([['exports', { key: 'exports', value: false, reason: 'STATIC' }]])) },
          },
        },
        { provide: APP_GUARD, useExisting: BridgeAuthGuard },
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    expect((await request(app.getHttpServer()).get('/exports').set('authorization', 'Bearer x')).status).toBe(403);
    expect((await request(app.getHttpServer()).get('/exports').set('x-api-key', 'k')).status).toBe(403);
    await app.close();
  });
});

describe('rules and defaultAccess decide whether a route is open to a key', () => {
  const rules: BridgeModuleOptions['guard'] = {
    rules: [
      { path: '/by-rule-gated', privilege: 'AUTHENTICATED', featureFlag: 'exports' },
      { path: '/by-rule-open', privilege: 'ANONYMOUS' },
      { path: '/by-rule-authenticated', privilege: 'AUTHENTICATED' },
    ],
  };
  let app: INestApplication;
  afterEach(async () => {
    await app.close();
  });

  it('a rule\'s featureFlag is a gate: a key with the privilege passes, one without gets 403', async () => {
    app = await appWith({ guard: rules } as BridgeModuleOptions, { forRequest: [] });
    expect((await request(app.getHttpServer()).get('/by-rule-gated').set('x-api-key', 'key-with')).status).toBe(200);
    expect((await request(app.getHttpServer()).get('/by-rule-gated').set('x-api-key', 'key-without')).status).toBe(403);
  });

  it('an ANONYMOUS rule opens the route to a key; an AUTHENTICATED rule without a flag does not', async () => {
    app = await appWith({ guard: rules } as BridgeModuleOptions, { forRequest: [] });
    expect((await request(app.getHttpServer()).get('/by-rule-open').set('x-api-key', 'key-without')).status).toBe(200);
    const refused = await request(app.getHttpServer()).get('/by-rule-authenticated').set('x-api-key', 'key-with');
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('KEY_ROUTE_NOT_OPEN');
    expect((await request(app.getHttpServer()).get('/by-rule-authenticated').set('authorization', 'Bearer person-token')).status).toBe(200);
  });

  it('guard.defaultAccess "public" is the developer opening every route no rule names', async () => {
    app = await appWith({ guard: { defaultAccess: 'public' } } as BridgeModuleOptions, { forRequest: [] });
    expect((await request(app.getHttpServer()).get('/plain').set('x-api-key', 'key-without')).status).toBe(200);
  });
});
