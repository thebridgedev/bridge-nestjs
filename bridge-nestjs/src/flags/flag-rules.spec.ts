// TBP-644 — FlagRulesLoader + helpers.

import { BridgeFlags, type CachedFlag } from '@nebulr-group/bridge-auth-core';

import { FlagRulesLoader, appIdFromApiKey, realtimeAcceptsApiToken } from './flag-rules';

const ON: CachedFlag = { key: 'beta', state: 'on', valueType: 'boolean', offValue: false, onValue: true } as CachedFlag;
const OFF: CachedFlag = { ...ON, state: 'off' } as CachedFlag;

function jwt(claims: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256', typ: 'JWT' })}.${b(claims)}.sig`;
}

function reply(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('appIdFromApiKey', () => {
  it('reads the appId claim of a Bridge API token', () => {
    expect(appIdFromApiKey(jwt({ appId: 'app-1', type: 'api' }))).toBe('app-1');
  });
  it('falls back to aid', () => {
    expect(appIdFromApiKey(jwt({ aid: 'app-2' }))).toBe('app-2');
  });
  it('returns undefined for a non-JWT key or no claim', () => {
    expect(appIdFromApiKey('opaque-key')).toBeUndefined();
    expect(appIdFromApiKey(jwt({ sub: 'x' }))).toBeUndefined();
    expect(appIdFromApiKey(undefined)).toBeUndefined();
  });
});

describe('realtimeAcceptsApiToken', () => {
  it('is true only for an AppSync config that advertises acceptsApiToken', () => {
    expect(realtimeAcceptsApiToken({ kind: 'appsync', params: { acceptsApiToken: true } })).toBe(true);
    expect(realtimeAcceptsApiToken({ kind: 'appsync', params: {} })).toBe(false);
    expect(realtimeAcceptsApiToken({ kind: 'appsync', params: { acceptsApiToken: 'true' } })).toBe(false);
    expect(realtimeAcceptsApiToken({ kind: 'centrifugo', params: { acceptsApiToken: true } })).toBe(false);
    expect(realtimeAcceptsApiToken(null)).toBe(false);
  });
});

describe('FlagRulesLoader', () => {
  function setup(fetchImpl: (url: string) => Promise<Response>, now = () => 1_000) {
    const bridge = new BridgeFlags({ mode: 'backend' });
    const fetchFn = jest.fn(fetchImpl) as unknown as typeof fetch;
    const errors: string[] = [];
    const loader = new FlagRulesLoader(bridge, {
      apiBaseUrl: 'https://api.test/',
      appId: 'app 1',
      fetchFn,
      now,
      onError: (m) => errors.push(m),
    });
    return { bridge, fetchFn: fetchFn as unknown as jest.Mock, loader, errors };
  }

  it('fetches flags-cache for the app and hydrates the cache', async () => {
    const { bridge, fetchFn, loader } = setup(async () => reply([ON]));
    expect(bridge.flag('beta', false).value).toBe(false); // unknown → default
    await expect(loader.refresh()).resolves.toBe(true);
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.test/admin/flags-internal/flags-cache/app%201');
    expect(bridge.flag('beta', false).value).toBe(true);
    expect(loader.loadedAt).toBe(1_000);
  });

  it('shares one request between concurrent refreshes', async () => {
    const { fetchFn, loader } = setup(async () => reply([ON]));
    await Promise.all([loader.refresh(), loader.refresh(), loader.refresh()]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refreshIfOlderThan only refetches once the rules are older than the limit', async () => {
    let t = 1_000;
    const { fetchFn, loader } = setup(async () => reply([ON]), () => t);
    loader.refreshIfOlderThan(500); // never loaded → loads
    await loader.refresh();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    t = 1_400;
    loader.refreshIfOlderThan(500);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    t = 1_600;
    loader.refreshIfOlderThan(500);
    await loader.refresh(); // joins the in-flight one
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('a newer rule set replaces the old one (flag turned off)', async () => {
    let rules = [ON];
    const { bridge, loader } = setup(async () => reply(rules));
    await loader.refresh();
    rules = [OFF];
    await loader.refresh();
    expect(bridge.flag('beta', true).value).toBe(false);
  });

  it('keeps the last good rules when a load fails, and reports it', async () => {
    let fail = false;
    const { bridge, loader, errors } = setup(async () => {
      if (fail) throw new Error('ECONNRESET');
      return reply([ON]);
    });
    await loader.refresh();
    fail = true;
    await expect(loader.refresh()).resolves.toBe(false);
    expect(bridge.flag('beta', false).value).toBe(true);
    expect(errors[0]).toMatch(/ECONNRESET/);
  });

  it('rejects a non-2xx or non-list answer without touching the cache', async () => {
    let body: Response = reply([ON]);
    const { bridge, loader, errors } = setup(async () => body);
    await loader.refresh();
    body = reply({ message: 'nope' }, 503);
    await loader.refresh();
    body = reply({ not: 'a list' });
    await loader.refresh();
    expect(bridge.flag('beta', false).value).toBe(true);
    expect(errors).toEqual([
      expect.stringMatching(/answered 503/),
      expect.stringMatching(/did not return a list/),
    ]);
  });
});
