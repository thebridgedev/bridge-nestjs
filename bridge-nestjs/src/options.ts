import type { BridgeServerOptions } from '@nebulr-group/bridge-auth-core/server';

/** A flag requirement: one flag, any of several, or all of several. */
export type FeatureFlagRequirement = string | { any: string[] } | { all: string[] };

/** Whether a route needs a signed-in caller. */
export type RoutePrivilege = 'ANONYMOUS' | 'AUTHENTICATED';

/**
 * A rule for routes you would rather list in one place than decorate. A
 * decorator on the handler wins over a rule.
 */
export interface RouteRule {
  /**
   * An HTTP route, with `*` for one segment and `**` for any number. Matched,
   * ignoring case and a trailing slash, against the route the router resolved
   * as it was declared (`/users/:id`, with any global prefix), never against
   * the URL the client sent: `/users/*` covers `@Get('users/:id')`.
   */
  path?: string;
  /**
   * A GraphQL resolver, as `Type.field` from your schema (`Query.catalog`,
   * `Mutation.deleteNote`). Checked for each field the document asks for, so
   * the operation's name, which the client chooses, never decides.
   */
  graphqlField?: string;
  /** Limit a `path` rule to one HTTP method. */
  method?: string;
  /** `ANONYMOUS`: open to everyone. `AUTHENTICATED`: needs a valid credential. */
  privilege: RoutePrivilege;
  /** The flag (or flags) that must be on for the caller. */
  featureFlag?: FeatureFlagRequirement;
}

export interface GuardConfig {
  /** Apply `BridgeAuthGuard` to every route of the app. @default false */
  global?: boolean;
  /** Routes no rule or decorator mentions are `protected` (a credential is needed) or `public`. @default 'protected' */
  defaultAccess?: 'public' | 'protected';
  rules?: RouteRule[];
  /**
   * Check writes (POST, PUT, PATCH, DELETE) against a revocation list at most
   * `strictLagMs` behind, so a removed member or ended session cannot write
   * in the seconds after. @default true
   */
  strictWrites?: boolean;
}

export interface BridgeModuleOptions {
  /**
   * The app's issuer, as the browser SDK takes it. Everything else (the key
   * set, the revocation list, the API's addresses) is read from the issuer's
   * metadata.
   */
  issuer: string;
  /**
   * The app's own key, for counting usage and for the management client.
   * Keep it on the server, in an environment variable.
   */
  appKey?: string;
  /** The access tokens' audience, only for an issuer whose metadata does not name it. */
  audience?: string;
  guard?: GuardConfig;
  /** The route that lets a person upgrade, named in a `402 FEATURE_NOT_IN_PLAN` refusal. @default '/subscription' */
  manageRoute?: string;
  /**
   * The webhook signing secret (`whsec_…`) for `BridgeWebhookGuard`. Give two
   * while a rotation's overlap lasts, the new one first.
   */
  webhookSecrets?: string | string[];
  /** Log what the guard decides. Never logs a credential. @default false */
  debug?: boolean;
  /** How far behind the revocation list may fall before checks answer 503. @default 300000 */
  maxLagMs?: number;
  /** The tighter limit for writes. @default 30000 */
  strictLagMs?: number;
  /** How often new revocations are fetched. @default 2000 */
  revocationIntervalMs?: number;
  /** How often counted usage is sent. @default 5000 */
  usageFlushMs?: number;
  /** A `fetch` to use instead of the global one (tests, proxies). */
  fetch?: BridgeServerOptions['fetch'];
  /** How long a management client call may take before it fails with `network`. @default 10000 */
  managementTimeoutMs?: number;
}

export interface BridgeModuleAsyncOptions {
  imports?: any[];
  inject?: any[];
  useFactory: (...args: any[]) => Promise<Partial<BridgeModuleOptions>> | Partial<BridgeModuleOptions>;
}

export const BRIDGE_DEFAULTS = {
  manageRoute: '/subscription',
  defaultAccess: 'protected' as const,
  strictWrites: true,
} as const;

/** The resolved module options. */
export const BRIDGE_OPTIONS = Symbol.for('bridge-nestjs:options');
/** The auth-core server (`createBridgeServer`) the module made. */
export const BRIDGE_SERVER = Symbol.for('bridge-nestjs:server');
