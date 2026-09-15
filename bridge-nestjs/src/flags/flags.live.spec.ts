// TBP-644 — BridgeFlagsModule keeps its rules current.
//
// Before this change the module never loaded any rules (every flag() returned
// its default, @RequireFlag refused routes whose flag was ON), and its
// realtime client connected with no app id and no credential. These tests pin
// the behaviour end to end through the Nest module, with `fetch` and the
// WebSocket faked through the documented `realtime.fetchFn` /
// `realtime.websocketFactory` options.

import 'reflect-metadata';

import { Test, type TestingModule } from '@nestjs/testing';
import type { CachedFlag } from '@nebulr-group/bridge-auth-core';

import { BridgeFlagsModule } from './flags.module';
import { BridgeFlagsService } from './flags.service';

const APP = 'app-9';
const ON: CachedFlag = { key: 'beta', state: 'on', valueType: 'boolean', offValue: false, onValue: true } as CachedFlag;
const OFF: CachedFlag = { ...ON, state: 'off' } as CachedFlag;

function jwt(claims: Record<string, unknown>): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256', typ: 'JWT' })}.${b(claims)}.sig`;
}
const API_KEY = jwt({ appId: APP, type: 'api', sub: 'tok-1' });

function reply(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface FakeWs {
  url: string;
  protocols: string[];
  readyState: number;
  sent: string[];
  send(d: string): void;
  close: jest.Mock;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

function harness(opts: { acceptsApiToken?: boolean; rules?: () => CachedFlag[] } = {}) {
  const sockets: FakeWs[] = [];
  let rules = opts.rules ?? (() => [ON]);
  const fetchFn = jest.fn(async (url: string) => {
    if (url.includes('/admin/flags-internal/flags-cache/')) return reply(rules());
    if (url.endsWith('/realtime/config')) {
      return reply({
        kind: 'appsync',
        endpoint: 'abc.appsync-realtime-api.eu-west-1.amazonaws.com',
        protocol: 'appsync-events',
        params: { region: 'eu-west-1', ...(opts.acceptsApiToken ? { acceptsApiToken: true } : {}) },
      });
    }
    return reply({}, 404);
  });
  const websocketFactory = jest.fn((url: string, protocols?: string | string[]) => {
    const ws: FakeWs = {
      url,
      protocols: Array.isArray(protocols) ? protocols : protocols ? [protocols] : [],
      readyState: 1,
      sent: [],
      send(d: string) {
        this.sent.push(d);
      },
      close: jest.fn(),
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    sockets.push(ws);
    return ws;
  });
  return {
    sockets,
    fetchFn,
    websocketFactory,
    setRules: (r: () => CachedFlag[]) => {
      rules = r;
    },
    calls: (part: string) => fetchFn.mock.calls.filter(([u]) => String(u).includes(part)).length,
  };
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

async function build(h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      BridgeFlagsModule.forRoot({
        apiBaseUrl: 'https://api.test',
        apiKey: API_KEY,
        telemetry: { enabled: false },
        realtime: { fetchFn: h.fetchFn as unknown as typeof fetch, websocketFactory: h.websocketFactory as any },
        ...extra,
      } as any),
    ],
  }).compile();
}

describe('BridgeFlagsModule — rule loading (TBP-644)', () => {
  it('loads the app rules before the module is ready: an ON flag reads ON on the first call', async () => {
    const h = harness();
    const mod = await build(h);
    const flags = mod.get(BridgeFlagsService);
    expect(flags.flag('beta', false)).toBe(true);
    expect(h.fetchFn.mock.calls.some(([u]) => u === `https://api.test/admin/flags-internal/flags-cache/${APP}`)).toBe(true);
    await mod.close();
  });

  it('an explicit appId wins over the API key claim', async () => {
    const h = harness();
    const mod = await build(h, { appId: 'app-explicit' });
    expect(h.fetchFn.mock.calls.some(([u]) => String(u).endsWith('/flags-cache/app-explicit'))).toBe(true);
    await mod.close();
  });

  it('without any app id it loads nothing and makes no request', async () => {
    const h = harness();
    const mod = await build(h, { apiKey: 'opaque-key' });
    expect(mod.get(BridgeFlagsService).flag('beta', false)).toBe(false);
    expect(h.fetchFn).not.toHaveBeenCalled();
    await mod.close();
  });

  it('pull mode: never probes realtime, and refreshes the rules on read once older than the TTL', async () => {
    const h = harness();
    const mod = await build(h, { runtimeMode: 'pull', pullCache: { ttlMs: 30 } });
    const flags = mod.get(BridgeFlagsService);
    expect(flags.flag('beta', false)).toBe(true);
    h.setRules(() => [OFF]);
    expect(flags.flag('beta', true)).toBe(true); // within TTL — no refetch
    expect(h.calls('flags-cache')).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    flags.flag('beta', true); // stale → background refresh
    await flush();
    expect(flags.flag('beta', true)).toBe(false);
    expect(h.calls('/realtime/config')).toBe(0);
    expect(h.websocketFactory).not.toHaveBeenCalled();
    await mod.close();
  });

  it('the raw BRIDGE_FLAGS instance (as used by @Flag) refreshes too', async () => {
    const h = harness();
    const mod = await build(h, { runtimeMode: 'pull', pullCache: { ttlMs: 30 } });
    const raw = mod.get(BridgeFlagsService).bridge;
    h.setRules(() => [OFF]);
    await new Promise((r) => setTimeout(r, 40));
    raw.flag('beta', true);
    await flush();
    expect(raw.flag('beta', true).value).toBe(false);
    await mod.close();
  });
});

describe('BridgeFlagsModule — live channel (TBP-644)', () => {
  it('does not open a socket when the deployment does not admit server SDKs, and still refreshes on the TTL', async () => {
    const h = harness({ acceptsApiToken: false });
    const mod = await build(h, { pullCache: { ttlMs: 30 } });
    const flags = mod.get(BridgeFlagsService);
    await flush();
    expect(h.calls('/realtime/config')).toBe(1);
    expect(h.websocketFactory).not.toHaveBeenCalled();
    h.setRules(() => [OFF]);
    await new Promise((r) => setTimeout(r, 40));
    flags.flag('beta', true);
    await flush();
    expect(flags.flag('beta', true)).toBe(false);
    await mod.close();
  });

  it('connects with the API token as credential and subscribes to app:<appId> when admitted', async () => {
    const h = harness({ acceptsApiToken: true });
    const mod = await build(h);
    await flush();
    expect(h.websocketFactory).toHaveBeenCalledTimes(1);
    const ws = h.sockets[0];
    const header = ws.protocols.find((p) => p.startsWith('header-'))!;
    const auth = JSON.parse(Buffer.from(header.slice('header-'.length), 'base64url').toString('utf8'));
    expect(auth.Authorization).toBe(`Bearer ${API_KEY}`);

    ws.onopen?.({});
    ws.onmessage?.({ data: JSON.stringify({ type: 'connection_ack' }) });
    const subscribes = ws.sent.map((s) => JSON.parse(s)).filter((f) => f.type === 'subscribe');
    expect(subscribes).toHaveLength(1);
    expect(subscribes[0].channel).toMatch(new RegExp(`app.${APP}$`));
    await mod.close();
  });

  it('re-loads the rules when the channel opens (catch-up after a gap)', async () => {
    const h = harness({ acceptsApiToken: true });
    const mod = await build(h);
    await flush();
    const ws = h.sockets[0];
    h.setRules(() => [OFF]);
    ws.onopen?.({});
    ws.onmessage?.({ data: JSON.stringify({ type: 'connection_ack' }) });
    const sub = ws.sent.map((s) => JSON.parse(s)).find((f) => f.type === 'subscribe');
    ws.onmessage?.({ data: JSON.stringify({ type: 'subscribe_success', id: sub.id }) });
    await flush();
    expect(h.calls('flags-cache')).toBe(2);
    expect(mod.get(BridgeFlagsService).flag('beta', true)).toBe(false);
    await mod.close();
  });

  it('a flag.updated push applies without a refetch while the channel is open', async () => {
    const h = harness({ acceptsApiToken: true });
    const mod = await build(h);
    await flush();
    const ws = h.sockets[0];
    ws.onopen?.({});
    ws.onmessage?.({ data: JSON.stringify({ type: 'connection_ack' }) });
    const sub = ws.sent.map((s) => JSON.parse(s)).find((f) => f.type === 'subscribe');
    ws.onmessage?.({ data: JSON.stringify({ type: 'subscribe_success', id: sub.id }) });
    await flush();
    const before = h.calls('flags-cache');
    ws.onmessage?.({
      data: JSON.stringify({ type: 'data', id: sub.id, event: [JSON.stringify({ kind: 'flag.updated', flag: OFF })] }),
    });
    const flags = mod.get(BridgeFlagsService);
    expect(flags.flag('beta', true)).toBe(false);
    await flush();
    expect(h.calls('flags-cache')).toBe(before); // open channel → reads don't poll
    await mod.close();
  });

  it('realtime.enabled=false keeps the socket closed but the rules loaded', async () => {
    const h = harness({ acceptsApiToken: true });
    const mod = await build(h, {
      realtime: { enabled: false, fetchFn: h.fetchFn as unknown as typeof fetch, websocketFactory: h.websocketFactory as any },
    });
    expect(mod.get(BridgeFlagsService).flag('beta', false)).toBe(true);
    expect(h.calls('/realtime/config')).toBe(0);
    expect(h.websocketFactory).not.toHaveBeenCalled();
    await mod.close();
  });
});
