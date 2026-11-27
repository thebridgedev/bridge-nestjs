import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import type {
  Actor,
  BridgeServer,
  FlagSet,
  Hint,
  RequestLike,
  VerifyOptions,
} from '@nebulr-group/bridge-auth-core/server';
import { workspaceInHeaders } from './flags/key-workspace';
import { BRIDGE_DEFAULTS, BRIDGE_OPTIONS, BRIDGE_SERVER, type BridgeModuleOptions } from './options';
import { bridgeStateOf } from './request-context';

/**
 * The Bridge on the app's server: check a request's credential, read the
 * caller's flag results and count usage. The guard and decorators use it;
 * inject it where a decorator does not fit.
 */
@Injectable()
export class BridgeService implements OnModuleDestroy {
  constructor(
    @Inject(BRIDGE_SERVER) private readonly server: BridgeServer,
    @Optional() @Inject(BRIDGE_OPTIONS) private readonly options?: BridgeModuleOptions,
  ) {}

  /** Resolves once the issuer's metadata is read and token checks are set up. */
  get ready(): Promise<void> {
    return this.server.ready;
  }

  /**
   * Checks the request's credential (`Authorization: Bearer`, or
   * `x-api-key`) and returns its Actor. Throws a `BridgeError`: 401, or 503
   * while Bridge cannot be checked (never a yes).
   */
  verify(request: RequestLike, options: VerifyOptions = {}): Promise<Actor> {
    return this.server.verify(request, options);
  }

  /** As `verify`, as a result instead of a throw. */
  check(request: RequestLike, options: VerifyOptions = {}) {
    return this.server.check(request, options);
  }

  /** The Actor the guard verified for this request, or null. */
  actorOf(request: object): Actor | null {
    return bridgeStateOf(request)?.actor ?? null;
  }

  /**
   * The caller's flag results, worked out by Bridge for the person or key
   * whose credential came with the request. A request nobody signed in to
   * (a public route) gets what Bridge shows any visitor: the flags marked
   * public, and every other flag gives its fallback. Read once per request
   * when the guard ran.
   */
  flags(request: RequestLike, hints: Readonly<Record<string, Hint>> = {}): Promise<FlagSet> {
    const state = bridgeStateOf(request);
    if (state !== undefined && Object.keys(hints).length === 0) return state.flags();
    if (state !== undefined && state.actor === null) return this.server.flags.forVisitor(hints);
    // A key may name the workspace whose plan its results use; auth-core sends it with a key and never with a person's token.
    const workspace = workspaceInHeaders(request.headers as Record<string, string | readonly string[] | undefined>);
    return this.server.flags.forRequest(request, hints, workspace === undefined ? {} : { workspace });
  }

  /**
   * The flag results Bridge gives a visitor: public flags only, asked with no
   * credential. For code with no request, or a route the guard does not cover.
   * `hints` are facts your server knows; never pass what the visitor sent as
   * a fact. A flag you have not marked public is absent, so it gives its
   * fallback.
   */
  visitorFlags(hints: Readonly<Record<string, Hint>> = {}): Promise<FlagSet> {
    return this.server.flags.forVisitor(hints);
  }

  /** Whether a boolean flag is on for the caller. Off unless Bridge said on. */
  async enabled(request: RequestLike, key: string): Promise<boolean> {
    return (await this.flags(request)).enabled(key);
  }

  /**
   * Counts usage of a metric for the caller's workspace ("count this"). Sent
   * in batches; a batch that fails is sent again with the same ids. Needs the
   * app key.
   */
  count(actor: Actor, metric: string, quantity = 1, options: { id?: string; workspace?: string } = {}): void {
    this.server.usage.count(actor, metric, quantity, options);
  }

  /** Sends what is counted now. */
  flush(): Promise<void> {
    return this.server.usage.flush();
  }

  /**
   * Whether this server can serve on its copy of the revocation list, for a
   * health check: `reads` while it is at most `maxLagMs` behind (5 minutes),
   * `writes` while at most `strictLagMs` (90 seconds). Past either limit the
   * guard refuses those requests with 503, never yes.
   */
  revocationHealth(): { ready: boolean; lagMs: number | null; reads: boolean; writes: boolean; maxLagMs: number; strictLagMs: number } {
    const status = this.server.status();
    const maxLagMs = this.options?.maxLagMs ?? BRIDGE_DEFAULTS.maxLagMs;
    const strictLagMs = this.options?.strictLagMs ?? BRIDGE_DEFAULTS.strictLagMs;
    const ready = status?.ready ?? false;
    const lagMs = status !== null && Number.isFinite(status.lagMs) ? status.lagMs : null;
    return { ready, lagMs, reads: ready && lagMs !== null && lagMs <= maxLagMs, writes: ready && lagMs !== null && lagMs <= strictLagMs, maxLagMs, strictLagMs };
  }

  /** How the revocation list is followed, for a health check. Null before setup. */
  status() {
    return this.server.status();
  }

  /** What the issuer published. Available once `ready` resolves. */
  metadata() {
    return this.server.metadata();
  }

  async onModuleDestroy(): Promise<void> {
    await this.server.close();
  }
}
