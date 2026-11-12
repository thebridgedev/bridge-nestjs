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

/** The GraphQL operation's name, when the call is GraphQL. */
export function graphqlOperationOf(context: ExecutionContext): string | null {
  if (context.getType<string>() !== 'graphql') return null;
  const info = context.getArgByIndex(3) as { operation?: { name?: { value?: string } }; fieldName?: string } | undefined;
  return info?.operation?.name?.value ?? info?.fieldName ?? null;
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
