import { BridgeError, createBridgeManagement } from '../src';

const endpoints = {
  accounts: 'https://bridge.example.test/v2/accounts',
  billing: 'https://bridge.example.test/v2/billing',
  sessions: 'https://bridge.example.test/v2/identity-access/sessions',
};
const server = { ready: Promise.resolve(), metadata: () => ({ endpoints }) as never };

function recorder(status = 200, body: unknown = { ok: true }, headers: Record<string, string> = {}) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe('management client', () => {
  it('calls each route with the app key and names the workspace', async () => {
    const { calls, fetch } = recorder();
    const management = createBridgeManagement({ server, appKey: 'k', fetch });
    await management.workspaces.create({ name: 'Acme' });
    await management.workspace('ws-1').invites.send({ email: 'a@acme.test', role: 'MEMBER' });
    await management.workspace('ws-1').billing.choosePlan({ plan: 'pro', currency: 'usd', interval: 'month' });
    await management.workspace('ws-1').setSubscription({ plan: 'pro' });
    await management.workspace('ws-1').members.remove('m/1');
    await management.plans.list();
    expect(calls.map((c) => `${c.method} ${c.url} ${c.headers['bridge-workspace'] ?? '-'}`)).toEqual([
      'POST https://bridge.example.test/v2/accounts/workspaces -',
      'POST https://bridge.example.test/v2/accounts/invites ws-1',
      'POST https://bridge.example.test/v2/billing/payer/plan ws-1',
      'PUT https://bridge.example.test/v2/billing/payer/subscription ws-1',
      'DELETE https://bridge.example.test/v2/accounts/members/m%2F1 ws-1',
      'GET https://bridge.example.test/v2/billing/plans -',
    ]);
    expect(calls.every((c) => c.headers['x-api-key'] === 'k' && c.headers['authorization'] === undefined)).toBe(true);
    expect(calls[1].body).toEqual({ email: 'a@acme.test', role: 'MEMBER' });
  });

  it('makes keys and workspace keys as the calling person, with their token', async () => {
    const { calls, fetch } = recorder(201, { id: 'key-1', secret: 'shown-once' });
    const management = createBridgeManagement({ server, appKey: 'k', fetch });
    const caller = management.forCaller({ headers: { authorization: 'Bearer person-token' } });
    await caller.workspaceKeys.create({ name: 'CI', privileges: ['reports:read'] });
    await caller.keys.list();
    await caller.workspace.members.list();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://bridge.example.test/v2/identity-access/workspace-keys',
      'GET https://bridge.example.test/v2/identity-access/keys',
      'GET https://bridge.example.test/v2/accounts/members',
    ]);
    expect(calls.every((c) => c.headers['authorization'] === 'Bearer person-token' && c.headers['x-api-key'] === undefined && c.headers['bridge-workspace'] === undefined)).toBe(true);
    expect(() => management.forCaller({ headers: {} })).toThrow(BridgeError);
  });

  it('acts for a workspace key\'s own workspace with that key', async () => {
    const { calls, fetch } = recorder();
    const management = createBridgeManagement({ server, appKey: 'k', fetch });
    await management.withKey('workspace-key').workspace.billing.usage();
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://bridge.example.test/v2/billing/payer/usage' });
    expect(calls[0].headers['x-api-key']).toBe('workspace-key');
    expect(calls[0].headers['bridge-workspace']).toBeUndefined();
  });

  it('turns a refusal into a BridgeError', async () => {
    const { fetch } = recorder(403, { type: 'urn:bridge:problem:forbidden', title: 'Forbidden', status: 403, detail: 'Not yours.' });
    const management = createBridgeManagement({ server, appKey: 'k', fetch });
    await expect(management.workspace('ws-1').get()).rejects.toMatchObject({ kind: 'forbidden', status: 403, code: 'forbidden', message: 'Not yours.' });
    const limited = recorder(429, {}, { 'retry-after': '7' });
    await expect(createBridgeManagement({ server, appKey: 'k', fetch: limited.fetch }).plans.list()).rejects.toMatchObject({ kind: 'rate-limited', retryAfterSeconds: 7 });
  });

  it('refuses to call without the app key', async () => {
    const { fetch } = recorder();
    await expect(createBridgeManagement({ server, fetch }).plans.list()).rejects.toMatchObject({ kind: 'misconfigured' });
  });
  /** A Bridge that never answers until the call is aborted. */
  const stalled = () => {
    const signals: (AbortSignal | undefined)[] = [];
    const fetch = ((_url: string, init: RequestInit) => {
      signals.push(init.signal ?? undefined);
      return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    }) as unknown as typeof globalThis.fetch;
    return { signals, fetch };
  };

  it('gives up on a Bridge that does not answer within timeoutMs, as a network error', async () => {
    const { signals, fetch } = stalled();
    const started = Date.now();
    await expect(createBridgeManagement({ server, appKey: 'k', fetch, timeoutMs: 100 }).plans.list()).rejects.toMatchObject({ kind: 'network', message: 'Bridge did not answer within 100 ms.' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('gives up on an answer whose body stalls', async () => {
    const fetch = ((_url: string, init: RequestInit) => {
      const body = new ReadableStream({ start: (controller) => init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason)) });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    await expect(createBridgeManagement({ server, appKey: 'k', fetch, timeoutMs: 100 }).plans.list()).rejects.toMatchObject({ kind: 'network' });
  });

  it('times every call out by default, after 10 seconds', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    try {
      const { calls, fetch } = recorder();
      await createBridgeManagement({ server, appKey: 'k', fetch }).plans.list();
      expect(calls).toHaveLength(1);
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
  });
});
