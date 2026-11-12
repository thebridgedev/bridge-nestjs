/**
 * What the parity suite shares: its settings, the demo app started against a
 * real issuer, and the calls a test makes the way an app's own server makes
 * them (the app's key on Bridge's public API, a person's tokens from the
 * public sign-in routes). Nothing here prints, logs or writes a secret.
 *
 * Settings come from the environment, set by whoever runs the suite (see
 * e2e/parity/README.md):
 *
 *   PARITY_ISSUER      the test app's issuer
 *   PARITY_APP_KEY     the test app's own key, with the privileges the suite uses
 *   PARITY_HARNESS     a local address for what only the app's developer can do (see `Harness`)
 *   PARITY_INBOX_DOMAIN  a domain whose mail the harness can read, for invites
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BRIDGE_OPTIONS, BridgeService, type BridgeModuleOptions } from '@nebulr-group/bridge-nestjs';
import { AppModule } from '../../../demo/src/app.module';

export interface ParityEnv {
  readonly issuer: string;
  readonly appId: string;
  readonly origin: string;
  readonly appKey: string;
  readonly harness: string | null;
  readonly inboxDomain: string | null;
}

export function parityEnv(env: NodeJS.ProcessEnv = process.env): ParityEnv | null {
  const issuer = env['PARITY_ISSUER'] ?? '';
  const appKey = env['PARITY_APP_KEY'] ?? '';
  if (issuer === '' || appKey === '') return null;
  const url = new URL(issuer);
  return {
    issuer,
    appId: url.pathname.split('/').filter(Boolean).pop() ?? '',
    origin: url.origin,
    appKey,
    harness: (env['PARITY_HARNESS'] ?? '') === '' ? null : (env['PARITY_HARNESS'] as string),
    inboxDomain: (env['PARITY_INBOX_DOMAIN'] ?? '') === '' ? null : (env['PARITY_INBOX_DOMAIN'] as string),
  };
}

/** `describe` when the suite is set up, else skipped with the reason in its name. */
export const describeParity = (name: string, body: (env: ParityEnv) => void): void => {
  const env = parityEnv();
  if (env === null) describe.skip(`${name} (set PARITY_ISSUER and PARITY_APP_KEY: see e2e/parity/README.md)`, () => undefined);
  else describe(name, () => body(env));
};

export async function eventually<T>(check: () => Promise<T>, ms = 15_000, everyMs = 250): Promise<{ value: T; tookMs: number }> {
  const start = Date.now();
  for (;;) {
    try {
      return { value: await check(), tookMs: Date.now() - start };
    } catch (error) {
      if (Date.now() - start > ms) throw error;
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The demo, as an app's server runs it, against the test app's real issuer and the app's own key. */
export async function startDemo(env: ParityEnv, extra: Partial<BridgeModuleOptions> = {}): Promise<INestApplication> {
  const options: BridgeModuleOptions = { issuer: env.issuer, appKey: env.appKey, guard: { global: true }, usageFlushMs: 1_000, ...extra };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(BRIDGE_OPTIONS).useValue(options).compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  await app.init();
  await app.get(BridgeService).ready;
  return app;
}

export interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly text: string;
  readonly headers: Headers;
}

/** A call on Bridge's public API (`/v2/...`), with the app's key or none. */
export async function api(env: ParityEnv, method: string, path: string, init: { key?: string; workspace?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
  const headers: Record<string, string> = { accept: 'application/json', ...(init.headers ?? {}) };
  if (init.key !== undefined) headers['x-api-key'] = init.key;
  if (init.workspace !== undefined) headers['bridge-workspace'] = init.workspace;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${env.origin}/v2${path}`, { method, headers, redirect: 'manual', ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') body = Array.isArray(parsed) ? { items: parsed } : (parsed as Record<string, unknown>);
  } catch {
    // not JSON
  }
  return { status: response.status, body, text, headers: response.headers };
}

export function expectStatus(answer: Answer, ...statuses: number[]): Answer {
  if (!statuses.includes(answer.status)) throw new Error(`answered ${String(answer.status)}, not ${statuses.join(' or ')}: ${answer.text.slice(0, 300)}`);
  return answer;
}

/** A person of the test app, signed in. */
export interface Person {
  readonly email: string;
  readonly userId: string;
  readonly memberId: string | null;
  readonly workspaceId: string;
  readonly token: string;
  readonly refreshToken: string;
  readonly issuedAt: number;
}

async function signInWithPassword(env: ParityEnv, email: string, password: string, workspace: string): Promise<{ token: string; refreshToken: string }> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const challenged = expectStatus(await api(env, 'POST', `/identity-access/apps/${env.appId}/sign-in`, { body: { email, password, workspace, code_challenge: challenge, code_challenge_method: 'S256' } }), 200);
  const tokens = expectStatus(await api(env, 'POST', `/identity-access/apps/${env.appId}/token`, { body: { grant_type: 'authorization_code', code: challenged.body['code'], code_verifier: verifier } }), 200);
  return { token: String(tokens.body['access_token']), refreshToken: String(tokens.body['refresh_token']) };
}

/** The app's server copies a password link; the person sets their password from it. */
async function setPassword(env: ParityEnv, email: string): Promise<string> {
  const link = expectStatus(await api(env, 'POST', '/identity-access/password-links', { key: env.appKey, body: { email } }), 201);
  const password = randomBytes(18).toString('base64url');
  expectStatus(await api(env, 'POST', `/identity-access/apps/${env.appId}/password`, { body: { token: link.body['token'], password } }), 200);
  return password;
}

/** A throwaway address on a domain no mail is delivered to. */
export const throwawayEmail = (what: string): string => `parity-${what}-${randomUUID().slice(0, 8)}@check.invalid`;

/**
 * A token signed in within the first seconds of a new member is refused as "access to the workspace changed" (a change Bridge makes
 * right after adding them lands after it): sign in once those seconds have passed. A new workspace needs no wait: its first token is
 * good (bridge-server fixed that in c800eea, TBP-902).
 */
const settle = (since: number): Promise<void> => sleep(Math.max(0, since + 5_000 - Date.now()));

/** A new workspace with a new person as its Owner, signed in to it. */
export async function newOwner(env: ParityEnv, what = 'owner'): Promise<Person> {
  const email = throwawayEmail(what);
  const created = expectStatus(await api(env, 'POST', '/accounts/workspaces', { key: env.appKey, body: { owner: { email }, name: `Parity ${what}` } }), 201).body;
  const workspaceId = String(created['id']);
  const owner = created['owner'] as { id: string; user: { id: string } };
  const password = await setPassword(env, email);
  const signed = await signInWithPassword(env, email, password, workspaceId);
  return { email, userId: owner.user.id, memberId: owner.id, workspaceId, ...signed, issuedAt: Date.now() };
}

/** A new person added to a workspace by the app's server, signed in to it. */
export async function newMember(env: ParityEnv, workspaceId: string, role = 'MEMBER', what = 'member'): Promise<Person> {
  const email = throwawayEmail(what);
  const startedAt = Date.now();
  const added = expectStatus(await api(env, 'POST', '/accounts/members', { key: env.appKey, workspace: workspaceId, body: { email, role } }), 201).body;
  const password = await setPassword(env, email);
  await settle(startedAt);
  const signed = await signInWithPassword(env, email, password, workspaceId);
  return { email, userId: String((added['user'] as { id: unknown }).id), memberId: String(added['id']), workspaceId, ...signed, issuedAt: Date.now() };
}

/** Makes a flag in the test app, or leaves it as it is when it exists; sets its state either way. */
export async function setFlag(env: ParityEnv, key: string, state: 'on' | 'off'): Promise<void> {
  const made = await api(env, 'POST', '/flags/flags', { key: env.appKey, body: { key, description: 'Parity suite', state } });
  if (made.status === 201) return;
  if (made.status !== 409) expectStatus(made, 201);
  // A change to a flag that exists names the revision it was made on.
  const current = expectStatus(await api(env, 'GET', `/flags/flags/${encodeURIComponent(key)}`, { key: env.appKey }), 200);
  expectStatus(await api(env, 'PATCH', `/flags/flags/${encodeURIComponent(key)}`, { key: env.appKey, body: { state }, headers: { 'if-match': current.headers.get('etag') ?? '' } }), 200);
}

/** What only the app's developer does, asked of the local harness (never a secret in a URL). */
export class Harness {
  constructor(private readonly address: string) {}

  async call<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.address}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    if (!response.ok) throw new Error(`the harness answered ${String(response.status)} for ${path}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as T;
  }
}
