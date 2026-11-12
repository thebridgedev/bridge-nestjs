import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type {
  Actor,
  BridgeServer,
  FlagSet,
  Hint,
  RequestLike,
  VerifyOptions,
} from '@nebulr-group/bridge-auth-core/server';
import { BRIDGE_SERVER } from './options';
import { bridgeStateOf } from './request-context';

/**
 * The Bridge on the app's server: check a request's credential, read the
 * caller's flag results and count usage. The guard and decorators use it;
 * inject it where a decorator does not fit.
 */
@Injectable()
export class BridgeService implements OnModuleDestroy {
  constructor(@Inject(BRIDGE_SERVER) private readonly server: BridgeServer) {}

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
   * The caller's flag results, worked out by Bridge for the person whose token
   * came with the request. Without a person's token every flag gives its
   * fallback. Read once per request when the guard ran.
   */
  flags(request: RequestLike, hints: Readonly<Record<string, Hint>> = {}): Promise<FlagSet> {
    const state = bridgeStateOf(request);
    if (state !== undefined && Object.keys(hints).length === 0) return state.flags();
    return this.server.flags.forRequest(request, hints);
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
