import { BridgeConflictError, BridgeError, createBridgeManagement } from '../src';

const endpoints = {
  accounts: 'https://bridge.example.test/v2/accounts',
  billing: 'https://bridge.example.test/v2/billing',
  flags: 'https://bridge.example.test/v2/flags',
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

/** One scripted answer per call, in order: status, body and headers. */
function script(...answers: [number, unknown, Record<string, string>?][]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const [status, body, headers] = answers[calls.length - 1] ?? [200, {}];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(headers ?? {}) } });
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
  describe('flags', () => {
    const flag = { id: 'f1', key: 'new-checkout', state: 'on', revision: 7 };

    it('calls the app\'s flag routes with the app key', async () => {
      const { calls, fetch } = recorder();
      const { flags } = createBridgeManagement({ server, appKey: 'k', fetch });
      await flags.list();
      await flags.list({ fields: ['key', 'state'] });
      await flags.get('new/checkout');
      await flags.create({ key: 'new-checkout', state: 'off', valueType: 'boolean' });
      await flags.delete('new-checkout');
      await flags.kill('new-checkout');
      await flags.restore('new-checkout');
      await flags.schedules.list();
      await flags.schedules.list({ flag: 'new-checkout' });
      await flags.schedules.create('new-checkout', { at: new Date('2030-01-01T00:00:00Z'), patch: { state: 'on' } });
      await flags.schedules.cancel('abc123');
      await flags.export();
      await flags.import({ version: 1, flags: [{ key: 'a' }] }, { dryRun: true });
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        'GET https://bridge.example.test/v2/flags/flags',
        'GET https://bridge.example.test/v2/flags/flags?fields=key%2Cstate',
        'GET https://bridge.example.test/v2/flags/flags/new%2Fcheckout',
        'POST https://bridge.example.test/v2/flags/flags',
        'DELETE https://bridge.example.test/v2/flags/flags/new-checkout',
        'POST https://bridge.example.test/v2/flags/flags/new-checkout/kill',
        'POST https://bridge.example.test/v2/flags/flags/new-checkout/restore',
        'GET https://bridge.example.test/v2/flags/schedules',
        'GET https://bridge.example.test/v2/flags/schedules?flag=new-checkout',
        'POST https://bridge.example.test/v2/flags/flags/new-checkout/schedules',
        'DELETE https://bridge.example.test/v2/flags/schedules/abc123',
        'GET https://bridge.example.test/v2/flags/export',
        'POST https://bridge.example.test/v2/flags/import',
      ]);
      expect(calls.every((c) => c.headers['x-api-key'] === 'k' && c.headers['authorization'] === undefined && c.headers['bridge-workspace'] === undefined && c.headers['if-match'] === undefined)).toBe(true);
      expect(calls[3].body).toEqual({ key: 'new-checkout', state: 'off', valueType: 'boolean' });
      expect(calls[9].body).toEqual({ at: '2030-01-01T00:00:00.000Z', patch: { state: 'on' } });
      expect(calls[12].body).toEqual({ version: 1, flags: [{ key: 'a' }], dryRun: true });
    });

    it('reads the ETag from a get', async () => {
      const { fetch } = recorder(200, flag, { etag: '"7"' });
      const read = await createBridgeManagement({ server, appKey: 'k', fetch }).flags.getWithETag('new-checkout');
      expect(read).toEqual({ flag, etag: '"7"' });
    });

    it('names the revision a change is made on, whichever way it is given', async () => {
      const { calls, fetch } = recorder();
      const { flags } = createBridgeManagement({ server, appKey: 'k', fetch });
      await flags.update('new-checkout', { state: 'off' }, { ifMatch: '"7"' });
      await flags.update('new-checkout', { state: 'off' }, { ifMatch: 7 });
      await flags.update('new-checkout', { state: 'off' }, { ifMatch: '7' });
      await flags.delete('new-checkout', { ifMatch: 7 });
      await flags.schedules.create('new-checkout', { at: '2030-01-01T00:00:00Z', patch: { state: 'on' } }, { ifMatch: 7 });
      expect(calls.map((c) => `${c.method} ${c.headers['if-match']}`)).toEqual(['PATCH "7"', 'PATCH "7"', 'PATCH "7"', 'DELETE "7"', 'POST "7"']);
      await expect(flags.update('new-checkout', { state: 'off' }, { ifMatch: -1 })).rejects.toMatchObject({ kind: 'invalid' });
      await expect(flags.update('new-checkout', { state: 'off' }, { ifMatch: ' ' })).rejects.toMatchObject({ kind: 'invalid' });
      expect(calls).toHaveLength(5);
    });

    it('refuses an update that names no revision, without calling Bridge', async () => {
      const { calls, fetch } = recorder();
      const { flags } = createBridgeManagement({ server, appKey: 'k', fetch });
      await expect((flags.update as (...args: unknown[]) => Promise<unknown>)('new-checkout', { state: 'off' })).rejects.toMatchObject({ kind: 'invalid' });
      await expect((flags.update as (...args: unknown[]) => Promise<unknown>)('new-checkout', { state: 'off' }, {})).rejects.toMatchObject({ kind: 'invalid' });
      expect(calls).toHaveLength(0);
    });

    it('changes a flag on whatever revision it is at now, when the caller reads the ETag itself', async () => {
      const { calls, fetch } = script([200, flag, { etag: '"9"' }], [200, { ...flag, revision: 10 }]);
      const { flags } = createBridgeManagement({ server, appKey: 'k', fetch });
      const updated = await flags.update('new-checkout', { state: 'off' }, { ifMatch: (await flags.getWithETag('new-checkout')).etag });
      expect(updated).toMatchObject({ revision: 10 });
      expect(calls.map((c) => `${c.method} ${c.headers['if-match'] ?? '-'}`)).toEqual(['GET -', 'PATCH "9"']);
    });

    it('throws a typed conflict error when the flag has changed since the revision named', async () => {
      for (const status of [409, 412]) {
        const { fetch } = recorder(status, { type: 'urn:bridge:problem:conflict', title: 'Conflict', status, detail: 'The flag changed since revision 7: it is at 8.' });
        const failed = await createBridgeManagement({ server, appKey: 'k', fetch }).flags.update('new-checkout', { state: 'off' }, { ifMatch: 7 }).catch((error: unknown) => error);
        expect(failed).toBeInstanceOf(BridgeConflictError);
        expect(failed).toBeInstanceOf(BridgeError);
        expect(failed).toMatchObject({ kind: 'conflict', status, ifMatch: '"7"', message: 'The flag changed since revision 7: it is at 8.' });
      }
    });

    it('does not take a taken key for a stale revision', async () => {
      const { fetch } = recorder(409, { type: 'urn:bridge:problem:conflict', title: 'Conflict', status: 409, detail: 'A flag with that key exists.' });
      const failed = await createBridgeManagement({ server, appKey: 'k', fetch }).flags.create({ key: 'new-checkout' }).catch((error: unknown) => error);
      expect(failed).not.toBeInstanceOf(BridgeConflictError);
      expect(failed).toMatchObject({ kind: 'conflict', status: 409 });
    });

    it('turns a missing revision into an invalid-request error, and any call can name one through request()', async () => {
      const { calls, fetch } = recorder(428, { title: 'Precondition Required', status: 428, detail: 'Name the revision.' });
      const management = createBridgeManagement({ server, appKey: 'k', fetch });
      await expect(management.request('PATCH', 'flags', '/flags/a', { body: {} })).rejects.toMatchObject({ kind: 'invalid', status: 428 });
      await expect(management.request('PATCH', 'flags', '/flags/a', { body: {}, ifMatch: 3 })).rejects.toMatchObject({ kind: 'invalid', status: 428 });
      expect(calls.map((c) => c.headers['if-match'])).toEqual([undefined, '"3"']);
    });

    it('is the app key\'s alone: neither a workspace key nor a caller has flags', () => {
      const { fetch } = recorder();
      const management = createBridgeManagement({ server, appKey: 'k', fetch });
      expect('flags' in management.withKey('workspace-key')).toBe(false);
      expect('flags' in management.forCaller({ headers: { authorization: 'Bearer t' } })).toBe(false);
    });
  });
});
