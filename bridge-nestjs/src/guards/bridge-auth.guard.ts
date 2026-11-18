import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FlagSet, isBridgeError, type Actor, type BridgeError, type BridgeServer, type RequestLike } from '@nebulr-group/bridge-auth-core/server';
import { ACCEPT_AUTH_KEY, type AuthType } from '../decorators/accept-auth.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { REQUIRED_FEATURE_FLAG_KEY } from '../decorators/require-flag.decorator';
import { STRICT_KEY } from '../decorators/strict.decorator';
import { featureRefusal, featureRefusalBody, unmetFlag } from '../flags/feature-refusal';
import { billingLockedFrom } from '../quota/billing-locked';
import { BRIDGE_DEFAULTS, BRIDGE_OPTIONS, BRIDGE_SERVER, type BridgeModuleOptions, type FeatureFlagRequirement, type RouteRule } from '../options';
import { graphqlFieldOf, graphqlIsMutation, pathOf, requestOf, routePathOf, setBridgeState, setHeader, type HttpRequestLike } from '../request-context';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** What auth-core's check answers: an Actor, or the refusal. `flags` are the results it read for a write. */
type CheckedRequest = { ok: true; actor: Actor; flags?: FlagSet } | { ok: false; error: BridgeError };

const KEY_ROUTE_MESSAGE =
  'A key may call this route only when a flag gates it (@RequireFlag, or a rule\'s featureFlag) and the flag is on for the key, or when the route is open (@Public()).';

/** A person (or a job) arrives with a token of its own; every other kind of caller came with a key. */
function isKeyActor(actor: Actor): boolean {
  return actor.kind !== 'person' && actor.kind !== 'job';
}

/** A path as the router compares it: no repeated or trailing slash. */
function tidy(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

/**
 * A rule's path as a pattern: `*` is one segment, `**` any number. Case is
 * ignored and a trailing slash is optional, as in Express's default router.
 */
function pathPattern(path: string): RegExp {
  const escaped = tidy(path)
    .split('/')
    .map((segment) => (segment === '**' ? '.*' : segment === '*' ? '[^/]+' : segment.replace(/[.+?^${}()|[\]\\*]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${escaped}/?$`, 'i');
}

/**
 * The path a rule is matched against: the route the router resolved, so the
 * case, slashes or escapes the client sent cannot steer a request past its
 * rule. Only when the adapter names no route, the URL as a router would read
 * it: repeated slashes collapsed and each segment decoded.
 */
function rulePathOf(request: HttpRequestLike): string {
  const route = routePathOf(request);
  if (route !== null) return tidy(route);
  return tidy(
    pathOf(request)
      .split('/')
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      })
      .join('/'),
  );
}

const GRAPHQL_FIELD = /^[_A-Za-z][_0-9A-Za-z]*\.[_A-Za-z][_0-9A-Za-z]*$/;

function checkRule(rule: RouteRule): void {
  if ('graphqlOperation' in rule) {
    throw new Error('A route rule names `graphqlOperation`: the client chooses an operation\'s name, so it cannot gate. Use `graphqlField: \'Query.field\'`, or a decorator on the resolver.');
  }
  if (rule.graphqlField !== undefined && !GRAPHQL_FIELD.test(rule.graphqlField)) {
    throw new Error(`A route rule's graphqlField "${rule.graphqlField}" is not \`Type.field\`, such as \`Query.catalog\`.`);
  }
}

function header(request: HttpRequestLike, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Checks every request's credential through auth-core's verifier: the
 * signature against the app's key set, the issuer, the audience and the
 * expiry, and the app's revocation list, so a session that ended, a member who
 * was removed or a key that was revoked is refused within seconds. While Bridge
 * cannot be checked it answers 503, never yes.
 *
 * Then the route's flag requirement (`@RequireFlag`, or a rule's
 * `featureFlag`), evaluated by Bridge for the caller. A key is evaluated like
 * a person: it passes a gate when the flag's rule matches the key's
 * privileges. A key is refused on a route with no flag gate unless the route
 * is open (`@Public()`, an `ANONYMOUS` rule or `defaultAccess: 'public'`).
 */
@Injectable()
export class BridgeAuthGuard implements CanActivate {
  private readonly logger = new Logger('Bridge');
  private readonly rules: { rule: RouteRule; pattern: RegExp | null }[];

  constructor(
    private readonly reflector: Reflector,
    @Inject(BRIDGE_SERVER) private readonly server: BridgeServer,
    @Inject(BRIDGE_OPTIONS) private readonly options: BridgeModuleOptions,
  ) {
    const rules = options.guard?.rules ?? [];
    rules.forEach(checkRule);
    this.rules = rules.map((rule) => ({ rule, pattern: rule.path === undefined ? null : pathPattern(rule.path) }));
  }

  private log(message: string, details?: Record<string, unknown>): void {
    if (this.options.debug) this.logger.debug(details === undefined ? message : `${message} ${JSON.stringify(details)}`);
  }

  /**
   * The first rule for this call. A GraphQL call is matched on the resolver
   * it runs (`Type.field`) and only by `graphqlField` rules; an HTTP call on
   * its resolved route and only by `path` rules.
   */
  private findRule(context: ExecutionContext, request: HttpRequestLike): RouteRule | undefined {
    if (context.getType<string>() === 'graphql') {
      // A resolver that cannot be named matches no rule: its decorators and `defaultAccess` decide.
      const field = graphqlFieldOf(context);
      return field === null ? undefined : this.rules.find(({ rule }) => rule.graphqlField === field)?.rule;
    }
    const path = rulePathOf(request);
    const method = (request.method ?? '').toUpperCase();
    return this.rules.find(({ rule, pattern }) => {
      if (pattern === null) return false;
      if (rule.method !== undefined && rule.method.toUpperCase() !== method) return false;
      return pattern.test(path);
    })?.rule;
  }

  private metadata<T>(key: string, context: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [context.getHandler(), context.getClass()]);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = requestOf(context);
    if (request === null) {
      // Another transport carries no credential this guard can check: only a public handler passes.
      if (this.metadata<boolean>(IS_PUBLIC_KEY, context)) return true;
      throw new UnauthorizedException('This handler needs a credential, and its transport carries none.');
    }
    const rule = this.findRule(context, request);
    const open =
      this.metadata<boolean>(IS_PUBLIC_KEY, context) === true ||
      rule?.privilege === 'ANONYMOUS' ||
      (rule === undefined && (this.options.guard?.defaultAccess ?? BRIDGE_DEFAULTS.defaultAccess) === 'public');

    const accepted = this.metadata<AuthType>(ACCEPT_AUTH_KEY, context) ?? 'both';
    const credentials = this.credentialsFor(request, accepted);
    const method = (request.method ?? 'GET').toUpperCase();
    const strict = this.metadata<boolean>(STRICT_KEY, context) ?? ((this.options.guard?.strictWrites ?? BRIDGE_DEFAULTS.strictWrites) && WRITES.has(method));

    let actor: Actor | null = null;
    let checked: FlagSet | null = null;
    if (credentials === null) {
      if (!open) {
        this.log('Refused: no credential', { method, path: pathOf(request) });
        setHeader(context, 'WWW-Authenticate', 'Bearer');
        throw new UnauthorizedException({ statusCode: 401, error: 'Unauthorized', message: this.missingMessage(accepted) });
      }
    } else {
      // The method lets auth-core refuse a person's write in a workspace that is not active or is locked for payment.
      // A GraphQL query travels in a POST but only reads: only a mutation is a write.
      const writeMethod = graphqlIsMutation(context) === null ? method : graphqlIsMutation(context) ? 'POST' : 'GET';
      const withMethod: RequestLike & { method?: string } = { headers: credentials.headers, method: writeMethod };
      const result: CheckedRequest = await this.server.check(withMethod, { strict });
      if (result.ok) {
        actor = result.actor;
        // Read for the workspace check on a write: a gate on this request uses it, not a second call.
        checked = result.flags ?? null;
      } else if (!open) {
        this.refuse(context, result.error);
      } else {
        // A public route: a credential that does not check out is ignored, never trusted.
        this.log('Public route: the credential did not check out and is ignored', { code: result.error.code });
      }
    }

    let flags: Promise<FlagSet> | null = null;
    const readFlags = (): Promise<FlagSet> => {
      // Flags are read for the caller that checked out, a person or a key, never with a credential that failed its check.
      flags ??= actor === null ? Promise.resolve(new FlagSet()) : checked !== null ? Promise.resolve(checked) : this.server.flags.forRequest(credentials as RequestLike);
      return flags;
    };
    setBridgeState(request, { actor, flags: readFlags });

    const requirement = this.metadata<FeatureFlagRequirement>(REQUIRED_FEATURE_FLAG_KEY, context) ?? rule?.featureFlag;
    // A key is protected by default: on a route no flag gates it is refused, unless the developer opened the route.
    if (actor !== null && isKeyActor(actor) && requirement === undefined && !open) {
      this.log('Refused: a key on a route with no flag gate', { method, path: pathOf(request), kind: actor.kind });
      throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', message: KEY_ROUTE_MESSAGE, code: 'KEY_ROUTE_NOT_OPEN' });
    }
    if (requirement !== undefined) {
      const results = await readFlags();
      const unmet = unmetFlag(results, requirement);
      if (unmet !== null) {
        this.log('Refused: flag off', { flag: unmet });
        throw featureRefusal(featureRefusalBody(results, unmet, this.options.manageRoute ?? BRIDGE_DEFAULTS.manageRoute));
      }
    }
    this.log('Allowed', { method, path: pathOf(request), kind: actor?.kind ?? 'anonymous' });
    return true;
  }

  /** Only the headers the route accepts, so a second credential can never decide. Null when none of them came. */
  private credentialsFor(request: HttpRequestLike, accepted: AuthType): RequestLike | null {
    const authorization = header(request, 'authorization');
    const apiKey = header(request, 'x-api-key');
    const bearer = authorization !== undefined && /^Bearer\s+\S/i.test(authorization) ? authorization : undefined;
    if (accepted === 'jwt') return bearer === undefined ? null : { headers: { authorization: bearer } };
    if (accepted === 'api_token') return apiKey === undefined || apiKey === '' ? null : { headers: { 'x-api-key': apiKey } };
    if (bearer === undefined && (apiKey === undefined || apiKey === '')) return null;
    // Both came: the person's token decides, as it did in 0.x.
    return bearer !== undefined ? { headers: { authorization: bearer } } : { headers: { 'x-api-key': apiKey as string } };
  }

  private missingMessage(accepted: AuthType): string {
    if (accepted === 'jwt') return 'This endpoint needs a signed-in person: send Authorization: Bearer <token>.';
    if (accepted === 'api_token') return 'This endpoint needs a key: send x-api-key.';
    return 'This endpoint needs a credential: Authorization: Bearer <token>, or x-api-key.';
  }

  private refuse(context: ExecutionContext, error: unknown): never {
    // A workspace locked for payment: 0.9's 402 body (`BILLING_GATE_ENGAGED`), with Bridge's problem beside it.
    const locked = billingLockedFrom(error, this.options.manageRoute ?? BRIDGE_DEFAULTS.manageRoute);
    if (locked !== null) {
      this.log('Refused: the workspace is locked for payment', { status: 402, code: 'BILLING_GATE_ENGAGED' });
      throw locked;
    }
    // Bridge's own other refusals for a write (403 workspace not active, 503 cannot be told): the problem as the body.
    if (isBridgeError(error) && error.problem !== null && [402, 403, 503].includes(error.status)) {
      this.log('Refused: the workspace cannot be written to', { status: error.status, code: error.code });
      if (error.status === 503) setHeader(context, 'Retry-After', '5');
      throw new HttpException(error.problem, error.status);
    }
    if (isBridgeError(error) && error.status === 503) {
      this.log('Unavailable: Bridge cannot be checked right now', { code: error.code });
      setHeader(context, 'Retry-After', '5');
      throw new ServiceUnavailableException({ statusCode: 503, error: 'Service Unavailable', message: 'Credentials cannot be checked right now; try again shortly.' });
    }
    const code = isBridgeError(error) ? (error.code ?? 'invalid_token') : 'invalid_token';
    this.log('Refused: the credential did not check out', { code });
    const description = code === 'revoked' ? 'Access was taken away' : 'The credential is not valid';
    setHeader(context, 'WWW-Authenticate', `Bearer error="invalid_token", error_description="${description}"`);
    throw new UnauthorizedException({ statusCode: 401, error: 'Unauthorized', message: description, code });
  }
}

