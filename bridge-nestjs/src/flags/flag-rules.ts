// bridge-nestjs/flags — keeps the in-memory rule cache filled (TBP-644).
//
// `BridgeFlags` evaluates against rules it holds in memory. Nothing in this
// package ever put them there: the realtime client only `upsert`s the single
// flag a `flag.updated` push carries, so a server that never received a push
// — every server in pull mode, and every server whose live channel never
// opened — answered every `flag()` with the developer's default, and
// `@RequireFlag` refused routes whose flag was ON.
//
// Every frontend SDK (svelte/react/angular/nextjs) hydrates from the same
// endpoint on start and on each realtime (re)open; this is the server-side
// equivalent, plus a TTL-bounded refresh for when there is no live channel.

import type { BridgeFlags, CachedFlag } from '@nebulr-group/bridge-auth-core';

/**
 * The app an API key belongs to, read from its `appId` claim.
 *
 * Decoded WITHOUT verifying: the value only names which app's rule set to
 * download, and that endpoint is public (it serves the same rules every
 * anonymous browser of the app receives). It never grants anything — the key
 * itself is verified by Bridge wherever it is used as a credential.
 */
export function appIdFromApiKey(apiKey: string | undefined): string | undefined {
  const payload = typeof apiKey === 'string' ? apiKey.split('.')[1] : undefined;
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof claims.appId === 'string' && claims.appId) return claims.appId;
    if (typeof claims.aid === 'string' && claims.aid) return claims.aid;
  } catch {
    // not a JWT — no app id to read
  }
  return undefined;
}

export interface FlagRulesLoaderOptions {
  apiBaseUrl: string;
  appId: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Called with a short, secret-free message when a load fails. */
  onError?: (message: string) => void;
}

/**
 * Loads the app's rule set from `GET /admin/flags-internal/flags-cache/:appId`
 * and replaces the `BridgeFlags` cache with it. Concurrent callers share one
 * request; a failed load keeps the last good rules (flags freeze, never reset).
 */
export class FlagRulesLoader {
  private lastLoadedAt = 0;
  private inflight?: Promise<boolean>;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly bridge: BridgeFlags,
    private readonly opts: FlagRulesLoaderOptions,
  ) {
    this.fetchFn = opts.fetchFn ?? ((...args) => globalThis.fetch(...args));
    this.now = opts.now ?? (() => Date.now());
  }

  /** `now()` of the last successful load; 0 before the first one. */
  get loadedAt(): number {
    return this.lastLoadedAt;
  }

  /** Load now (joining a load already in flight). Resolves true on success. */
  refresh(): Promise<boolean> {
    if (!this.inflight) {
      this.inflight = this.load().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  /** Fire-and-forget refresh when the rules are older than `maxAgeMs`. */
  refreshIfOlderThan(maxAgeMs: number): void {
    if (this.inflight) return;
    if (this.lastLoadedAt !== 0 && this.now() - this.lastLoadedAt < maxAgeMs) return;
    void this.refresh();
  }

  private async load(): Promise<boolean> {
    const url = `${this.opts.apiBaseUrl.replace(/\/+$/, '')}/admin/flags-internal/flags-cache/${encodeURIComponent(this.opts.appId)}`;
    try {
      const res = await this.fetchFn(url, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        this.opts.onError?.(`flag rules could not be loaded: GET flags-cache answered ${res.status}`);
        return false;
      }
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) {
        this.opts.onError?.('flag rules could not be loaded: flags-cache did not return a list');
        return false;
      }
      // An empty list is a real answer (every flag deleted), so it replaces
      // the cache too.
      this.bridge.hydrate(body as CachedFlag[]);
      this.lastLoadedAt = this.now();
      return true;
    } catch (err) {
      this.opts.onError?.(`flag rules could not be loaded: ${(err as Error)?.message ?? String(err)}`);
      return false;
    }
  }
}

/**
 * True when this Bridge deployment's realtime authorizer accepts a server SDK's
 * API token for its own app channel (bridge-api advertises it on
 * `GET /realtime/config` as `params.acceptsApiToken`). Without it a server has
 * no credential the authorizer takes — see flags.module.ts.
 */
export function realtimeAcceptsApiToken(config: unknown): boolean {
  const c = config as { kind?: unknown; params?: Record<string, unknown> } | null;
  return !!c && c.kind === 'appsync' && c.params?.acceptsApiToken === true;
}
