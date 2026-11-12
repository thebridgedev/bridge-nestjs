import type { ExecutionContext } from '@nestjs/common';
import type { Actor, FlagSet } from '@nebulr-group/bridge-auth-core/server';

/** What the guard learned about one request. */
export interface BridgeRequestState {
  /** The verified caller, or null on a public route called without a credential. */
  readonly actor: Actor | null;
  /** The caller's flag results, read once per request. */
  flags(): Promise<FlagSet>;
}

/** A request with headers: Express, Fastify or a plain `{ headers }`. */
export interface HttpRequestLike {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
  originalUrl?: string;
  body?: unknown;
}

const states = new WeakMap<object, BridgeRequestState>();

export function setBridgeState(request: object, state: BridgeRequestState): void {
  states.set(request, state);
}

/** What the guard learned about this request, or undefined before it ran. */
export function bridgeStateOf(request: object): BridgeRequestState | undefined {
  return states.get(request);
}

/** The request behind an HTTP or GraphQL call. Null for other transports. */
export function requestOf(context: ExecutionContext): HttpRequestLike | null {
  const type = context.getType<string>();
  if (type === 'http') return context.switchToHttp().getRequest<HttpRequestLike>();
  if (type === 'graphql') {
    const gqlContext = context.getArgByIndex(2) as { req?: HttpRequestLike; request?: HttpRequestLike } | undefined;
    return gqlContext?.req ?? gqlContext?.request ?? null;
  }
  return null;
}

/** The response, to set headers on a refusal. Null for GraphQL and other transports. */
export function responseOf(context: ExecutionContext): { setHeader?: (name: string, value: string) => void; header?: (name: string, value: string) => void } | null {
  if (context.getType<string>() !== 'http') return null;
  return context.switchToHttp().getResponse();
}

/**
 * The resolver a GraphQL call runs, as `Type.field` (`Query.catalog`,
 * `Mutation.deleteNote`): names the server's schema defines. Never the
 * operation's name, which the client chooses. Null for other transports.
 */
export function graphqlFieldOf(context: ExecutionContext): string | null {
  if (context.getType<string>() !== 'graphql') return null;
  const info = context.getArgByIndex(3) as { parentType?: { name?: unknown }; fieldName?: unknown } | undefined;
  const type = info?.parentType?.name;
  const field = info?.fieldName;
  return typeof type === 'string' && typeof field === 'string' ? `${type}.${field}` : null;
}

/**
 * The route the HTTP router resolved for this request, as it was declared
 * (`/beta`, `/users/:id`, with any global prefix): Express's `request.route`,
 * Fastify's `routeOptions.url`. Whatever case, slashes or escapes the client
 * sent, it is the path of the handler that is about to run. Null when the
 * adapter does not say.
 */
export function routePathOf(request: HttpRequestLike): string | null {
  const shaped = request as { route?: { path?: unknown }; routeOptions?: { url?: unknown }; routerPath?: unknown };
  if (typeof shaped.route?.path === 'string') return shaped.route.path;
  if (typeof shaped.routeOptions?.url === 'string') return shaped.routeOptions.url;
  if (typeof shaped.routerPath === 'string') return shaped.routerPath;
  return null;
}

/** The path, without its query. */
export function pathOf(request: HttpRequestLike): string {
  const url = request.originalUrl ?? request.url ?? '/';
  const end = url.indexOf('?');
  return end === -1 ? url : url.slice(0, end);
}

export function setHeader(context: ExecutionContext, name: string, value: string): void {
  const response = responseOf(context);
  if (response === null) return;
  if (typeof response.setHeader === 'function') response.setHeader(name, value);
  else if (typeof response.header === 'function') response.header(name, value);
}
