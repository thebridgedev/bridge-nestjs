/**
 * A Bridge issuer in memory that signs: its metadata, its key set, the four
 * lanes of the revocation list (signed entries and checkpoints), flag results
 * over OFREP, usage reports, and a recorder for every other call.
 *
 * Tokens are signed the way Bridge signs them (PS256, `at+jwt`), so the real
 * verifier in auth-core checks them. Every key is made in the test run.
 */
import { CompactSign, SignJWT, exportJWK, generateKeyPair, type JWK, type JWTPayload } from 'jose';

export const ORIGIN = 'https://bridge.example.test';
export const APP = 'app-acme';
export const ISSUER = `${ORIGIN}/identity-access/apps/${APP}`;
export const AUDIENCE = 'https://api.example.test';
export const LANES = ['identity-access', 'accounts', 'billing', 'app-registry'] as const;
export type Lane = (typeof LANES)[number];

const encoder = new TextEncoder();

interface LaneKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK & { lane: string };
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };

export async function createSignedIssuer() {
  const token = await generateKeyPair('PS256', { extractable: true });
  const tokenJwk = { ...(await exportJWK(token.publicKey)), kid: 'acme-key-1', use: 'sig' };
  const laneKeys = {} as Record<Lane, LaneKey>;
  for (const lane of LANES) {
    const pair = await generateKeyPair('ES256', { extractable: true });
    laneKeys[lane] = { kid: `${lane}-key-1`, privateKey: pair.privateKey, publicJwk: { ...(await exportJWK(pair.publicKey)), kid: `${lane}-key-1`, alg: 'ES256', use: 'sig', lane } };
  }
  const entries: Record<Lane, string[]> = { 'identity-access': [], accounts: [], billing: [], 'app-registry': [] };
  /** Flag results per person (`sub`); `*` for everyone else with a token. */
  const flagResults = new Map<string, unknown[]>();
  const usage: unknown[] = [];
  const calls: RecordedCall[] = [];
  const answers = new Map<string, Answer>();
  let lanesDown = false;

  const laneUrl = (lane: Lane) => `${ORIGIN}/v2/${lane}/apps/${APP}/revocations/${lane}`;
  const v2 = (path: string) => `${ORIGIN}/v2${path}`;
  const metadata = {
    issuer: ISSUER,
    bridge_app: APP,
    bridge_access_token_audience: AUDIENCE,
    jwks_uri: v2(`/identity-access/apps/${APP}/jwks.json`),
    bridge_endpoints: {
      '2': {
        sign_in: v2(`/identity-access/apps/${APP}/sign-in`),
        token: v2(`/identity-access/apps/${APP}/token`),
        introspect: v2(`/identity-access/apps/${APP}/introspect`),
        jwks: v2(`/identity-access/apps/${APP}/jwks.json`),
        sessions: v2('/identity-access/sessions'),
        accounts: v2('/accounts'),
        billing: v2('/billing'),
        flags: v2('/flags'),
      },
    },
    bridge_revocation_lanes: Object.fromEntries(LANES.map((lane) => [lane, laneUrl(lane)])),
  };

  async function sign(key: LaneKey, payload: Record<string, unknown>, typ: string): Promise<string> {
    return new CompactSign(encoder.encode(JSON.stringify(payload))).setProtectedHeader({ alg: 'ES256', kid: key.kid, typ }).sign(key.privateKey);
  }

  function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }

  function claimsOf(authorization: string | null): JWTPayload | null {
    const match = authorization === null ? null : /^Bearer\s+(\S+)$/i.exec(authorization);
    if (match === null) return null;
    try {
      return JSON.parse(Buffer.from(match[1].split('.')[1], 'base64url').toString('utf8')) as JWTPayload;
    } catch {
      return null;
    }
  }

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname;
    if (path === `/identity-access/apps/${APP}/.well-known/openid-configuration`) return json(metadata);
    if (path === `/v2/identity-access/apps/${APP}/jwks.json`) return json({ keys: [tokenJwk, ...LANES.map((lane) => laneKeys[lane].publicJwk)] });
    for (const lane of LANES) {
      if (url.href.split('?')[0] === laneUrl(lane)) {
        if (lanesDown) throw new TypeError('fetch failed');
        const after = Number(url.searchParams.get('after') ?? '0');
        const list = entries[lane];
        const head = list.length;
        const checkpoint = await sign(laneKeys[lane], { v: 1, app: APP, lane, head, floor: 1, floorAt: 0, at: Date.now() }, 'revocation-checkpoint+jws');
        return json({ v: 1, app: APP, lane, checkpoint, entries: list.slice(after) });
      }
    }
    const text = method === 'GET' || method === 'HEAD' ? '' : await request.text();
    const body = text === '' ? null : (JSON.parse(text) as unknown);
    if (method === 'POST' && path === '/v2/flags/ofrep/v1/evaluate/flags') {
      const claims = claimsOf(request.headers.get('authorization'));
      if (claims === null) return json({ type: 'urn:bridge:problem:signed-out', status: 401 }, 401);
      return json({ flags: flagResults.get(String(claims.sub)) ?? flagResults.get('*') ?? [] });
    }
    if (method === 'POST' && path === '/v2/billing/usage') {
      if (request.headers.get('x-api-key') === null) return json({ status: 401 }, 401);
      usage.push(...((body as { reports: unknown[] }).reports ?? []));
      return json({ accepted: (body as { reports: unknown[] }).reports.length });
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    calls.push({ method, url: url.href, headers, body });
    const answer = answers.get(`${method} ${path}`);
    if (answer !== undefined) return json(answer.body ?? null, answer.status ?? 200, answer.headers);
    return json({ ok: true, method, path });
  };

  return {
    fetch: fetchImpl as typeof fetch,
    issuer: ISSUER,
    usage,
    calls,
    /** A person's access token, as Bridge signs it. */
    async personToken(overrides: JWTPayload = {}, options: { expiresIn?: string | number; issuer?: string; audience?: string } = {}): Promise<string> {
      return new SignJWT({ aid: APP, azp: APP, tid: 'ws-alpha', sid: 'sess-1', jti: `tok-${Math.random().toString(36).slice(2)}`, wst: 'active', ...overrides })
        .setProtectedHeader({ alg: 'PS256', kid: 'acme-key-1', typ: 'at+jwt' })
        .setIssuer(options.issuer ?? ISSUER)
        .setAudience(options.audience ?? AUDIENCE)
        .setSubject(typeof overrides.sub === 'string' ? overrides.sub : 'user-alice')
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? '5m')
        .sign(token.privateKey);
    },
    /** Adds a signed entry to a lane, as Bridge does when access is taken away. */
    async revoke(lane: Lane, revocation: Record<string, unknown> & { kind: string }): Promise<void> {
      const at = Date.now();
      const payload: Record<string, unknown> = { v: 1, app: APP, lane, seq: entries[lane].length + 1, at, ...revocation };
      if (!['token', 'session', 'key'].includes(revocation.kind) && payload['before'] === undefined) payload['before'] = at + 2000;
      entries[lane].push(await sign(laneKeys[lane], payload, 'revocation+jws'));
    },
    /** Flag results for a person (`sub`), or `*` for everyone with a token. */
    setFlags(sub: string, results: { key: string; value: unknown; reason?: string; metadata?: Record<string, unknown> }[]): void {
      flagResults.set(sub, results.map((result) => ({ reason: 'TARGETING_MATCH', ...result })));
    },
    /** What a call on `METHOD /v2/...` answers. */
    answer(method: string, path: string, answer: Answer): void {
      answers.set(`${method} ${path}`, answer);
    },
    setLanesDown(down: boolean): void {
      lanesDown = down;
    },
  };
}

export type SignedIssuer = Awaited<ReturnType<typeof createSignedIssuer>>;
