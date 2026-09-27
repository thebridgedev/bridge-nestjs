// TBP-275 — unit tests for TenantScope.usage (report + metered quota).
import { BridgePullCache } from '@nebulr-group/bridge-auth-core';
import { TenantScope, type QuotaSnapshot } from './tenant-scope';

const API = 'https://api.test';
const APP = 'app-1';
const JWT = 'jwt-1';

function makeScope(fetcher: typeof fetch): TenantScope {
  return new TenantScope(JWT, 'ck-1', new BridgePullCache({ ttlMs: 30_000 }), API, APP, fetcher);
}

function okJson(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe('TenantScope.usage (TBP-275)', () => {
  it('report POSTs /usage/ingest with metric/value/idempotencyKey + auth headers', async () => {
    const fetcher = jest.fn(async () => okJson({}));
    const scope = makeScope(fetcher as unknown as typeof fetch);

    await scope.usage.report('api_calls', 5, 'idem-1');

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/usage/ingest');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-1');
    expect((init.headers as Record<string, string>)['x-app-id']).toBe('app-1');
    expect(JSON.parse(init.body as string)).toEqual({ metric: 'api_calls', value: 5, idempotencyKey: 'idem-1' });
  });

  it('report defaults value to 1 and auto-generates an idempotency key', async () => {
    const fetcher = jest.fn(async () => okJson({}));
    const scope = makeScope(fetcher as unknown as typeof fetch);

    await scope.usage.report('tokens');

    const init = fetcher.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.value).toBe(1);
    expect(typeof body.idempotencyKey).toBe('string');
    expect(body.idempotencyKey.length).toBeGreaterThan(0);
  });

  it('report swallows transport errors (best-effort, never throws)', async () => {
    const fetcher = jest.fn(async () => {
      throw new Error('network down');
    });
    const scope = makeScope(fetcher as unknown as typeof fetch);
    await expect(scope.usage.report('m')).resolves.toBeUndefined();
  });

  it('report is a no-op for an empty metric', async () => {
    const fetcher = jest.fn(async () => okJson({}));
    const scope = makeScope(fetcher as unknown as typeof fetch);
    await scope.usage.report('');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('quota GETs /usage/quota/:metric and returns the snapshot incl. overage fields', async () => {
    const snap: QuotaSnapshot = {
      metric: 'api_calls',
      used: 1200,
      limit: 1000,
      remaining: -200,
      warningLevel: null,
      policy: 'metered',
      unitAmount: 0.002,
      currency: 'USD',
      overageEstimate: 0.4,
      overcap: true,
    };
    const fetcher = jest.fn(async () => okJson(snap));
    const scope = makeScope(fetcher as unknown as typeof fetch);

    const q = await scope.usage.quota('api_calls');

    expect(fetcher.mock.calls[0][0]).toBe('https://api.test/usage/quota/api_calls');
    expect(q).toEqual(snap);
  });

  it('quota returns null on 404 (no quota configured for the metric)', async () => {
    const fetcher = jest.fn(async () => okJson(null, 404));
    const scope = makeScope(fetcher as unknown as typeof fetch);
    expect(await scope.usage.quota('none')).toBeNull();
  });

  // TBP-699/704 — gauges: the absolute current count, PUT, never queued.
  it('set PUTs the absolute value to /usage/gauge/:metric with auth headers', async () => {
    const fetcher = jest.fn(async () => okJson({ metric: 'tickets', value: 4 }));
    const scope = makeScope(fetcher as unknown as typeof fetch);

    await scope.usage.set('tickets', 4);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/usage/gauge/tickets');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-1');
    expect((init.headers as Record<string, string>)['x-app-id']).toBe('app-1');
    expect(JSON.parse(init.body as string)).toEqual({ value: 4 });
  });

  it('set encodes the metric and accepts 0 (everything deleted)', async () => {
    const fetcher = jest.fn(async () => okJson({}));
    await makeScope(fetcher as unknown as typeof fetch).usage.set('storage/bytes', 0);
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe('https://api.test/usage/gauge/storage%2Fbytes');
  });

  it.each([-1, 1.5, NaN])('set rejects %p without calling Bridge — it is a count, not a change', async (value) => {
    const fetcher = jest.fn(async () => okJson({}));
    await expect(makeScope(fetcher as unknown as typeof fetch).usage.set('tickets', value)).rejects.toThrow(RangeError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('set rejects on a non-2xx answer (unlike report, it is not best-effort)', async () => {
    const fetcher = jest.fn(async () => okJson({ message: 'no' }, 400));
    await expect(makeScope(fetcher as unknown as typeof fetch).usage.set('users', 3)).rejects.toThrow(/400/);
  });

  it('set sends nothing for an unverifiable token', async () => {
    const fetcher = jest.fn(async () => okJson({}));
    const scope = new TenantScope(
      JWT,
      Promise.reject(new Error('unverified')),
      new BridgePullCache({ ttlMs: 30_000 }),
      API,
      APP,
      fetcher as unknown as typeof fetch,
    );
    await expect(scope.usage.set('tickets', 1)).rejects.toThrow('unverified');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
