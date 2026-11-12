import { BridgeError, type BridgeErrorKind, type BridgeServer } from '@nebulr-group/bridge-auth-core/server';

/**
 * The management client: the app's server calling Bridge's public API.
 * Framework-free: it needs the auth-core server (for the issuer's metadata)
 * and the app's key.
 *
 * Three ways to call:
 * - with the app's own key (`x-api-key`), for any of the app's workspaces,
 *   which each workspace call names (`Bridge-Workspace`);
 * - with a workspace key (`withKey(key)`), for that key's workspace;
 * - as the person calling the app's API (`forCaller(request)`), with their
 *   token, for what only a person may do: their keys and their workspace's
 *   keys. Bridge applies that person's privileges.
 *
 * Every address comes from the issuer's metadata; the client appends only the
 * route's own path, pinned to version 2 of Bridge's API.
 */

/** Which part of Bridge's API a call goes to, as the issuer's metadata names it. */
export type ApiArea = 'accounts' | 'billing' | 'identity-access';

export interface ManagementRequest {
  /** The workspace the call is for: sent as `Bridge-Workspace` with the app key. */
  readonly workspace?: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** The same key across retries of one write makes it happen once. */
  readonly idempotencyKey?: string;
}

export interface ManagementOptions {
  /** The auth-core server the module (or your code) made with `createBridgeServer`. */
  readonly server: Pick<BridgeServer, 'ready' | 'metadata'>;
  /** The app's own key. Needed for every call except `forCaller`. */
  readonly appKey?: string;
  readonly fetch?: typeof fetch;
  /** How long one call may take, answer included, before it fails with `network`. @default 10000 */
  readonly timeoutMs?: number;
}

/** How long a management call may take by default. */
export const MANAGEMENT_TIMEOUT_MS = 10_000;

type Json = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Credential = { readonly apiKey: string } | { readonly bearer: string };

const KIND_OF_STATUS: ReadonlyArray<[(status: number) => boolean, BridgeErrorKind]> = [
  [(s) => s === 400 || s === 413 || s === 415, 'invalid'],
  [(s) => s === 401, 'signed-out'],
  [(s) => s === 402, 'plan-required'],
  [(s) => s === 403, 'forbidden'],
  [(s) => s === 404 || s === 410, 'not-found'],
  [(s) => s === 409 || s === 412 || s === 422, 'conflict'],
  [(s) => s === 429, 'rate-limited'],
];

function errorOf(status: number, body: unknown, headers: Headers): BridgeError {
  const problem = body !== null && typeof body === 'object' ? (body as Json) : {};
  const type = typeof problem['type'] === 'string' ? problem['type'] : '';
  const code = type === '' ? null : (type.split(':').pop() ?? null);
  let kind: BridgeErrorKind = KIND_OF_STATUS.find(([test]) => test(status))?.[1] ?? 'unavailable';
  if (code === 'identity-recheck' || (status === 401 && (headers.get('www-authenticate') ?? '').includes('insufficient_user_authentication'))) kind = 'reauthenticate';
  const detail = typeof problem['detail'] === 'string' ? problem['detail'] : typeof problem['title'] === 'string' ? problem['title'] : `Bridge answered ${status}.`;
  const retryAfter = Number(headers.get('retry-after'));
  return new BridgeError(kind, detail, {
    status,
    code,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    entitlement: typeof problem['entitlement'] === 'string' ? problem['entitlement'] : null,
    problem: Object.keys(problem).length > 0 ? problem : null,
  });
}

function segment(value: string, name: string): string {
  if (typeof value !== 'string' || value === '') throw new BridgeError('invalid', `"${name}" is needed.`);
  return encodeURIComponent(value);
}

/** Calls one part of Bridge's API with one credential. */
class Caller {
  constructor(
    private readonly options: ManagementOptions,
    private readonly credential: () => Credential,
  ) {}

  private async base(area: ApiArea): Promise<string> {
    await this.options.server.ready;
    const endpoints = this.options.server.metadata().endpoints;
    if (area === 'identity-access') {
      // FALLBACK: the issuer lists no endpoint for keys; they sit next to `sessions` (`…/v2/identity-access`).
      const sessions = endpoints.sessions;
      if (sessions === undefined || !sessions.endsWith('/sessions')) throw new BridgeError('misconfigured', "The issuer's metadata lists no Identity and Access endpoint for keys.");
      return sessions.slice(0, -'/sessions'.length);
    }
    const found = endpoints[area];
    if (found === undefined) throw new BridgeError('misconfigured', `The issuer's metadata lists no "${area}" endpoint.`);
    return found.replace(/\/+$/, '');
  }

  async call<T = Json>(method: Method, area: ApiArea, path: string, request: ManagementRequest = {}): Promise<T> {
    const credential = this.credential();
    const url = new URL(`${await this.base(area)}${path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { accept: 'application/json' };
    if ('apiKey' in credential) headers['x-api-key'] = credential.apiKey;
    else headers['authorization'] = `Bearer ${credential.bearer}`;
    if (request.workspace !== undefined) headers['bridge-workspace'] = request.workspace;
    if (request.idempotencyKey !== undefined) headers['idempotency-key'] = request.idempotencyKey;
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    const fetchFn = this.options.fetch ?? globalThis.fetch;
    const timeoutMs = this.options.timeoutMs ?? MANAGEMENT_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeoutMs);
    const unreachable = (cause: unknown): BridgeError =>
      signal.aborted
        ? new BridgeError('network', `Bridge did not answer within ${timeoutMs} ms.`, { cause })
        : new BridgeError('network', `Bridge could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    let response: Response;
    let text: string;
    try {
      response = await fetchFn(url.href, {
        method,
        headers,
        redirect: 'manual',
        signal,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      // The time limit covers the answer's body too: a stalled stream fails the same way.
      text = await response.text();
    } catch (cause) {
      throw unreachable(cause);
    }
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) throw errorOf(response.status, body, response.headers);
    return body as T;
  }
}

function workspaceApi(caller: Caller, workspace: string | undefined) {
  const at = (request: ManagementRequest = {}): ManagementRequest => (workspace === undefined ? request : { ...request, workspace });
  return {
    /** The workspace. */
    get: () => caller.call('GET', 'accounts', '/workspace', at()),
    update: (patch: Json) => caller.call('PATCH', 'accounts', '/workspace', at({ body: patch })),
    /** Schedules the workspace's deletion; `restore` takes it back while it can. */
    delete: () => caller.call('DELETE', 'accounts', '/workspace', at()),
    restore: () => caller.call('POST', 'accounts', '/workspace/restore', at()),
    members: {
      list: (query?: ManagementRequest['query']) => caller.call('GET', 'accounts', '/members', at({ ...(query === undefined ? {} : { query }) })),
      get: (memberId: string) => caller.call('GET', 'accounts', `/members/${segment(memberId, 'memberId')}`, at()),
      update: (memberId: string, patch: Json) => caller.call('PATCH', 'accounts', `/members/${segment(memberId, 'memberId')}`, at({ body: patch })),
      remove: (memberId: string) => caller.call('DELETE', 'accounts', `/members/${segment(memberId, 'memberId')}`, at()),
      /** What removing a member would take with them. */
      deletionPreview: (memberId: string) => caller.call('GET', 'accounts', `/members/${segment(memberId, 'memberId')}/deletion-preview`, at()),
    },
    invites: {
      list: () => caller.call('GET', 'accounts', '/invites', at()),
      /** Invites an address; Bridge emails the link. */
      send: (invite: { email: string; role?: string }) => caller.call('POST', 'accounts', '/invites', at({ body: invite })),
      cancel: (inviteId: string) => caller.call('DELETE', 'accounts', `/invites/${segment(inviteId, 'inviteId')}`, at()),
    },
    /** The workspace as a payer: its plan, subscription and usage. */
    billing: {
      get: () => caller.call('GET', 'billing', '/payer', at()),
      usage: () => caller.call('GET', 'billing', '/payer/usage', at()),
      update: (patch: { name?: string; email?: string; country?: string }) => caller.call('PATCH', 'billing', '/payer', at({ body: patch })),
      choosePlan: (choice: { plan: string; currency?: string; interval?: string }) => caller.call('POST', 'billing', '/payer/plan', at({ body: choice })),
      startTrial: (plan: string) => caller.call('POST', 'billing', '/payer/trial', at({ body: { plan } })),
      cancel: () => caller.call('POST', 'billing', '/payer/cancel', at()),
      reactivate: () => caller.call('POST', 'billing', '/payer/reactivate', at()),
      portal: () => caller.call('GET', 'billing', '/payer/portal', at()),
    },
  };
}

function keysApi(caller: Caller, path: '/keys' | '/workspace-keys') {
  return {
    list: () => caller.call('GET', 'identity-access', path),
    /** Makes a key; its secret is in the answer, once. Needs a sign-in within the last few minutes. */
    create: (key: { name: string; privileges?: string[]; expiresInDays?: number }) => caller.call('POST', 'identity-access', path, { body: key }),
    revoke: (keyId: string) => caller.call('DELETE', 'identity-access', `${path}/${segment(keyId, 'keyId')}`),
  };
}

function bearerOf(request: { headers: unknown }): string | null {
  const headers = request.headers as Record<string, string | string[] | undefined> | { get?: (name: string) => string | null };
  const raw = typeof (headers as { get?: unknown }).get === 'function' ? (headers as { get: (n: string) => string | null }).get('authorization') : (headers as Record<string, string | string[] | undefined>)['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = typeof value === 'string' ? /^Bearer\s+(\S+)$/i.exec(value.trim()) : null;
  return match?.[1] ?? null;
}

export function createBridgeManagement(options: ManagementOptions) {
  const app = new Caller(options, () => {
    if (options.appKey === undefined || options.appKey === '') throw new BridgeError('misconfigured', 'The management client needs the app key: pass `appKey`.');
    return { apiKey: options.appKey };
  });

  return {
    /** Any call on Bridge's public API with the app key, for a route this client has no method for yet. */
    request: <T = Json>(method: Method, area: ApiArea, path: string, request?: ManagementRequest) => app.call<T>(method, area, path, request),
    workspaces: {
      list: (query?: ManagementRequest['query']) => app.call('GET', 'accounts', '/workspaces', query === undefined ? {} : { query }),
      /** Makes a workspace; `owner` names the person who owns it. */
      create: (workspace: { name: string; owner?: Json | string; locale?: string; metadata?: Json }) => app.call('POST', 'accounts', '/workspaces', { body: workspace }),
    },
    /** One workspace: itself, its members, invites and billing. */
    workspace: (workspaceId: string) => {
      segment(workspaceId, 'workspaceId');
      return {
        ...workspaceApi(app, workspaceId),
        /** Adds a person as a member directly, without an invite. */
        addMember: (member: { email: string; role?: string; firstName?: string; lastName?: string }) => app.call('POST', 'accounts', '/members', { workspace: workspaceId, body: member }),
        suspend: () => app.call('POST', 'accounts', '/workspace/suspend', { workspace: workspaceId }),
        resume: () => app.call('POST', 'accounts', '/workspace/resume', { workspace: workspaceId }),
        /** Sets the subscription as the app decides (no payment): plan, currency, interval, trial end. */
        setSubscription: (subscription: { plan: string; currency?: string; interval?: string; trialEnd?: string }) =>
          app.call('PUT', 'billing', '/payer/subscription', { workspace: workspaceId, body: subscription }),
      };
    },
    plans: {
      list: () => app.call('GET', 'billing', '/plans'),
      get: (key: string) => app.call('GET', 'billing', `/plans/${segment(key, 'key')}`),
    },
    roles: {
      list: () => app.call('GET', 'accounts', '/roles'),
    },
    users: {
      get: (userId: string) => app.call('GET', 'accounts', `/users/${segment(userId, 'userId')}`),
      suspend: (userId: string) => app.call('POST', 'accounts', `/users/${segment(userId, 'userId')}/suspend`),
      resume: (userId: string) => app.call('POST', 'accounts', `/users/${segment(userId, 'userId')}/resume`),
    },
    /**
     * With another key instead of the app key: a workspace key (or a
     * personal key) acts for its own workspace, with its own privileges.
     */
    withKey(key: string) {
      if (typeof key !== 'string' || key === '') throw new BridgeError('invalid', 'A key is needed.');
      const keyed = new Caller(options, () => ({ apiKey: key }));
      return {
        workspace: workspaceApi(keyed, undefined),
        request: <T = Json>(method: Method, area: ApiArea, path: string, request?: Omit<ManagementRequest, 'workspace'>) => keyed.call<T>(method, area, path, request),
      };
    },
    /**
     * As the person calling the app's API, with their own token: their
     * workspace (the one the token names) and the keys only a person may make.
     * Bridge applies their privileges. Throws when the request has no person's token.
     */
    forCaller(request: { headers: unknown }) {
      const bearer = bearerOf(request);
      if (bearer === null) throw new BridgeError('signed-out', 'This call is made as the signed-in person: the request has no Authorization: Bearer token.');
      const person = new Caller(options, () => ({ bearer }));
      return {
        workspace: workspaceApi(person, undefined),
        /** The person's own keys, which act as them. */
        keys: keysApi(person, '/keys'),
        /** The workspace's keys, which act for the workspace whoever made them. */
        workspaceKeys: keysApi(person, '/workspace-keys'),
        request: <T = Json>(method: Method, area: ApiArea, path: string, request?: Omit<ManagementRequest, 'workspace'>) => person.call<T>(method, area, path, request),
      };
    },
  };
}

export type BridgeManagement = ReturnType<typeof createBridgeManagement>;
