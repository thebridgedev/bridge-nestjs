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
export type ApiArea = 'accounts' | 'billing' | 'flags' | 'identity-access';

/**
 * The revision a change is made on: the ETag a read gave (`"42"`, quotes or not) or the flag's `revision` (`42`).
 * Bridge refuses the change when the thing has changed since.
 */
export type Revision = string | number;

export interface ManagementRequest {
  /** The workspace the call is for: sent as `Bridge-Workspace` with the app key. */
  readonly workspace?: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** The same key across retries of one write makes it happen once. */
  readonly idempotencyKey?: string;
  /** Sent as `If-Match`: the change is made only if the thing is still at this revision. */
  readonly ifMatch?: Revision;
}

/**
 * A change that named the revision it was made on (`ifMatch`) was refused because the thing has changed since:
 * read it again and redo the change. Bridge answers 409 (or 412) for this. It is a `BridgeError` of kind `conflict`.
 */
export class BridgeConflictError extends BridgeError {
  /** The `If-Match` the refused change was sent with, or null when it named none. */
  readonly ifMatch: string | null;

  constructor(message: string, init: ConstructorParameters<typeof BridgeError>[2], ifMatch: string | null) {
    super('conflict', message, init);
    this.ifMatch = ifMatch;
  }
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
  [(s) => s === 400 || s === 413 || s === 415 || s === 428, 'invalid'],
  [(s) => s === 401, 'signed-out'],
  [(s) => s === 402, 'plan-required'],
  [(s) => s === 403, 'forbidden'],
  [(s) => s === 404 || s === 410, 'not-found'],
  [(s) => s === 409 || s === 412 || s === 422, 'conflict'],
  [(s) => s === 429, 'rate-limited'],
];

function errorOf(status: number, body: unknown, headers: Headers, ifMatch: string | undefined): BridgeError {
  const problem = body !== null && typeof body === 'object' ? (body as Json) : {};
  const type = typeof problem['type'] === 'string' ? problem['type'] : '';
  const code = type === '' ? null : (type.split(':').pop() ?? null);
  let kind: BridgeErrorKind = KIND_OF_STATUS.find(([test]) => test(status))?.[1] ?? 'unavailable';
  if (code === 'identity-recheck' || (status === 401 && (headers.get('www-authenticate') ?? '').includes('insufficient_user_authentication'))) kind = 'reauthenticate';
  const detail = typeof problem['detail'] === 'string' ? problem['detail'] : typeof problem['title'] === 'string' ? problem['title'] : `Bridge answered ${status}.`;
  const retryAfter = Number(headers.get('retry-after'));
  const init = {
    status,
    code,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    entitlement: typeof problem['entitlement'] === 'string' ? problem['entitlement'] : null,
    problem: Object.keys(problem).length > 0 ? problem : null,
  };
  // A 409 on a call that named a revision is that revision being out of date; on any other call it is some other conflict (a name taken).
  if (status === 412 || (status === 409 && ifMatch !== undefined)) return new BridgeConflictError(detail, init, ifMatch ?? null);
  return new BridgeError(kind, detail, init);
}

/** The `If-Match` header's value for a revision: quoted, as an ETag is. */
function ifMatchOf(revision: Revision): string {
  if (typeof revision === 'number') {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new BridgeError('invalid', '"ifMatch" is a revision: a whole number, or the ETag a read gave.');
    return `"${String(revision)}"`;
  }
  const value = typeof revision === 'string' ? revision.trim() : '';
  if (value === '') throw new BridgeError('invalid', '"ifMatch" is a revision: a whole number, or the ETag a read gave.');
  return /^(?:W\/)?".*"$/.test(value) ? value : `"${value}"`;
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
    return (await this.send<T>(method, area, path, request)).body;
  }

  /** `call`, with the answer's headers too (a read's ETag). */
  async send<T = Json>(method: Method, area: ApiArea, path: string, request: ManagementRequest = {}): Promise<{ body: T; headers: Headers }> {
    const credential = this.credential();
    const url = new URL(`${await this.base(area)}${path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { accept: 'application/json' };
    if ('apiKey' in credential) headers['x-api-key'] = credential.apiKey;
    else headers['authorization'] = `Bearer ${credential.bearer}`;
    if (request.workspace !== undefined) headers['bridge-workspace'] = request.workspace;
    if (request.idempotencyKey !== undefined) headers['idempotency-key'] = request.idempotencyKey;
    const ifMatch = request.ifMatch === undefined ? undefined : ifMatchOf(request.ifMatch);
    if (ifMatch !== undefined) headers['if-match'] = ifMatch;
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
    if (!response.ok) throw errorOf(response.status, body, response.headers, ifMatch);
    return { body: body as T, headers: response.headers };
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

/** A flag as Bridge answers it. `revision` is what a change names in `ifMatch`. */
export interface ManagedFlag {
  readonly id: string;
  readonly key: string;
  readonly description: string;
  readonly state: 'off' | 'on' | 'on-with-rule';
  readonly valueType: 'boolean' | 'string' | 'number' | 'json';
  readonly onValue: unknown;
  readonly offValue: unknown;
  readonly rule: Json | null;
  readonly public: boolean;
  readonly revision: number;
  readonly [field: string]: unknown;
}

/** The fields of a flag a call may set. */
export interface FlagFields {
  readonly description?: string;
  readonly state?: ManagedFlag['state'];
  readonly valueType?: ManagedFlag['valueType'];
  readonly onValue?: unknown;
  readonly offValue?: unknown;
  /** The rule, or `null` to clear it. */
  readonly rule?: Json | null;
  readonly public?: boolean;
}

/** A change that waits for its time. */
export interface FlagSchedule {
  readonly id: string;
  readonly flag: string;
  readonly at: string;
  readonly patch: FlagFields;
  readonly status: 'pending' | 'applied' | 'held' | 'cancelled';
  readonly [field: string]: unknown;
}

/** What `flags.export()` gives and `flags.import()` takes: the app's flags and segments. */
export interface FlagBundle {
  readonly version: number;
  readonly flags: readonly Json[];
  readonly segments?: readonly Json[];
  readonly [field: string]: unknown;
}

export interface FlagRead {
  /** Which fields the answer keeps; the others are left out. */
  readonly fields?: readonly string[];
}

/** A change to a flag that must name the revision it was made on. */
export interface FlagUpdate {
  /** The revision the change is made on: `flags.getWithETag(key).etag`, or a flag's `revision`. The change is refused (`BridgeConflictError`) when the flag has changed since. */
  readonly ifMatch: Revision;
}

/** For a change to a flag that exists, where naming the revision is optional. */
export interface FlagChange {
  /** The revision the change is made on: `flags.getWithETag(key).etag`, or a flag's `revision`. The change is refused (`BridgeConflictError`) when the flag has changed since. */
  readonly ifMatch?: Revision;
}

const fieldsQuery = (read: FlagRead | undefined): ManagementRequest['query'] => (read?.fields === undefined ? undefined : { fields: read.fields.join(',') });

/**
 * The app's flags: what Control Center's flag screens do, for the app's own server (its key only; a person or a
 * workspace key does not manage the app's flags).
 */
function flagsApi(caller: Caller) {
  const at = (key: string): string => `/flags/${segment(key, 'key')}`;
  const read = (path: string, query: ManagementRequest['query']): Promise<{ body: ManagedFlag; headers: Headers }> => caller.send<ManagedFlag>('GET', 'flags', path, query === undefined ? {} : { query });
  return {
    list: (options?: FlagRead) => caller.call<ManagedFlag[]>('GET', 'flags', '/flags', { ...(fieldsQuery(options) === undefined ? {} : { query: fieldsQuery(options) }) }),
    get: async (key: string, options?: FlagRead): Promise<ManagedFlag> => (await read(at(key), fieldsQuery(options))).body,
    /** The flag with its ETag, which a later `update`, `delete` or `schedules.create` names as `ifMatch`. */
    getWithETag: async (key: string): Promise<{ flag: ManagedFlag; etag: string }> => {
      const { body, headers } = await read(at(key), undefined);
      return { flag: body, etag: headers.get('etag') ?? `"${String(body.revision)}"` };
    },
    /** Makes a flag. A key that exists is refused (`conflict`). */
    create: (flag: FlagFields & { key: string }) => caller.call<ManagedFlag>('POST', 'flags', '/flags', { body: flag }),
    /**
     * Changes the fields you give. A change to a flag names the revision it was made on (`ifMatch`), so nobody
     * overwrites what they did not see. Refused with a `BridgeConflictError` when the flag has changed since. For a
     * change that should win whatever happened in between, name the current revision: `{ ifMatch: (await flags.getWithETag(key)).etag }`.
     */
    update: (key: string, patch: FlagFields & { key?: string }, change: FlagUpdate): Promise<ManagedFlag> => {
      // A caller without types can still leave it out.
      if ((change as { ifMatch?: Revision } | undefined)?.ifMatch === undefined) return Promise.reject(new BridgeError('invalid', 'A change to a flag names the revision it was made on: pass "ifMatch".'));
      return caller.call<ManagedFlag>('PATCH', 'flags', at(key), { body: patch, ifMatch: change.ifMatch });
    },
    /** Deletes a flag. With `ifMatch`, only if it is still at that revision. */
    delete: (key: string, change?: FlagChange) => caller.call<{ deleted: boolean }>('DELETE', 'flags', at(key), { ...(change?.ifMatch === undefined ? {} : { ifMatch: change.ifMatch }) }),
    /** Switches the flag off, keeping its rule. Needs no revision. */
    kill: (key: string) => caller.call<ManagedFlag>('POST', 'flags', `${at(key)}/kill`),
    /** Switches a killed flag back to the state it had. */
    restore: (key: string) => caller.call<ManagedFlag>('POST', 'flags', `${at(key)}/restore`),
    schedules: {
      /** The waiting and past changes, of one flag or of all. */
      list: (query?: { flag?: string }) => caller.call<FlagSchedule[]>('GET', 'flags', '/schedules', { ...(query?.flag === undefined ? {} : { query: { flag: query.flag } }) }),
      /** A change to the flag at a time, from now to a year ahead. With `ifMatch`, only if the flag is still at that revision. */
      create: (key: string, schedule: { at: string | Date; patch: FlagFields }, change?: FlagChange) =>
        caller.call<FlagSchedule>('POST', 'flags', `${at(key)}/schedules`, {
          body: { at: schedule.at instanceof Date ? schedule.at.toISOString() : schedule.at, patch: schedule.patch },
          ...(change?.ifMatch === undefined ? {} : { ifMatch: change.ifMatch }),
        }),
      cancel: (scheduleId: string) => caller.call<{ cancelled: boolean }>('DELETE', 'flags', `/schedules/${segment(scheduleId, 'scheduleId')}`),
    },
    /** All the app's flags and segments, as a bundle `import` takes (for another app, or a script's copy). */
    export: () => caller.call<FlagBundle>('GET', 'flags', '/export'),
    /** Makes and changes what the bundle holds, whole or not at all; nothing is deleted. `dryRun` answers what it would do and does nothing. */
    import: (bundle: FlagBundle, options?: { dryRun?: boolean }) => caller.call<Json>('POST', 'flags', '/import', { body: { ...bundle, ...(options?.dryRun === undefined ? {} : { dryRun: options.dryRun }) } }),
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
    /** The app's feature flags: list, make, change (with `ifMatch`), kill, schedule, export and import. */
    flags: flagsApi(app),
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
