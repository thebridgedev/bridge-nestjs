/**
 * Feature flag requirement - can be a single flag, any of multiple flags, or all of multiple flags
 */
export type FeatureFlagRequirement =
  | string
  | { any: string[] }
  | { all: string[] };

/**
 * Who may reach a route at all.
 * ANONYMOUS     — no authentication required
 * AUTHENTICATED — any valid credential (user JWT or API token)
 *
 * Anything finer than "signed in" is a flag: set `featureFlag` on the rule
 * and give the flag a rule on a privilege (`privileges contains "USER_WRITE"`),
 * a plan feature (`bridge:billing.entitlement.<key> eq true`) or a rollout.
 * An API token's scope is `@RequirePrivilege` on the handler (API tokens only).
 */
export type RoutePrivilege = 'ANONYMOUS' | 'AUTHENTICATED';

/**
 * Route rule for centralized guard configuration.
 * Provide either `path` (REST) or `graphqlOperation` (GraphQL) — or both.
 */
export interface RouteRule {
  /** REST URL wildcard pattern (e.g. "/account/subscription/**") */
  path?: string;
  /** GraphQL operation name, case-sensitive camelCase (e.g. "listUsers") */
  graphqlOperation?: string;
  /** Whether the route needs a signed-in caller: 'ANONYMOUS' or 'AUTHENTICATED'. */
  privilege: RoutePrivilege;
  /**
   * The flag that decides who gets this route (TBP-472). Evaluated for the
   * request's user JWT via the same path as `@RequireFeatureFlag`; the flag's
   * rule says why (privilege, plan feature, rollout). Refuses with 402
   * FEATURE_NOT_IN_PLAN / 403 FEATURE_NOT_PERMITTED / 403 FEATURE_OFF.
   * Fail-closed on resolution error.
   */
  featureFlag?: FeatureFlagRequirement;
}

/**
 * Guard configuration for global or route-based protection
 */
export interface GuardConfig {
  /** Enable global guard (applies to all routes) */
  global?: boolean;
  /** Default access level when no rule matches */
  defaultAccess?: 'public' | 'protected';
  /** Route rules for centralized configuration */
  rules?: RouteRule[];
}

/**
 * Bridge module configuration
 */
export interface BridgeConfig {
  /**
   * Your Bridge application ID
   * @required
   */
  appId: string;

  /**
   * Base URL for the Bridge API. All endpoints are derived from this.
   * @default 'https://api.thebridge.dev'
   */
  apiBaseUrl?: string;

  /**
   * Guard configuration
   */
  guard?: GuardConfig;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Override the token-introspection URL for API token verification.
   * API tokens are signed with the per-app HS256 secret (which this app never
   * holds), so they are verified by POSTing them to the Bridge rather than
   * locally. Override this in Docker when the container can't reach the public
   * apiBaseUrl.
   * @default {apiBaseUrl}/account/api-token/introspect
   */
  introspectionUrl?: string;

  /**
   * How long (ms) a successful API-token introspection is cached, keyed by
   * token. Trades revocation latency for fewer network calls. `0` disables
   * caching → every request introspects (instant revocation).
   * @default 0
   */
  introspectionCacheTtlMs?: number;

  /**
   * @deprecated TBP-411 — API tokens are HS256-signed with a per-app secret, so
   * they can never be verified against a JWKS; the endpoint this pointed at
   * published the symmetric secret as an `oct` key and was itself auth-gated.
   * Verification now goes through Bridge token introspection. Set
   * {@link introspectionUrl} instead. This field is ignored.
   */
  apiTokenJwksUrl?: string;

  /**
   * Override the JWKS URL for user JWT verification.
   * Useful in Docker when the container can't reach the public apiBaseUrl.
   * @default {apiBaseUrl}/auth/.well-known/jwks.json
   */
  userJwksUrl?: string;

  /**
   * Billing settings used by `@RequireQuota` / `@RequireEntitlement` refusals
   * (TBP-704).
   */
  billing?: BillingConfig;
}

/** TBP-704 — where a refused request tells the user to go to upgrade. */
export interface BillingConfig {
  /**
   * Route of your app's subscription page. Sent as `fix` in 402
   * `QUOTA_EXCEEDED` and 403 `ENTITLEMENT_REQUIRED` bodies so the frontend
   * can link the user straight to it.
   * @default '/subscription'
   */
  manageRoute?: string;
}

/**
 * TBP-704 — what `BridgeModule.forRoot()` accepts. Everything is optional:
 * `appId`, `apiBaseUrl` and `debug` fall back to the `BRIDGE_APP_ID`,
 * `BRIDGE_API_BASE_URL` and `BRIDGE_DEBUG` environment variables; a value
 * passed here always wins over the environment.
 */
export type BridgeModuleConfig = Omit<BridgeConfig, 'appId'> & { appId?: string };

/**
 * Async module options for BridgeModule.forRootAsync()
 */
export interface BridgeModuleAsyncOptions {
  imports?: any[];
  inject?: any[];
  useFactory: (...args: any[]) => Promise<BridgeConfig> | BridgeConfig;
}

/**
 * Default configuration values
 */
export const BRIDGE_DEFAULTS = {
  apiBaseUrl: 'https://api.thebridge.dev',
  manageRoute: '/subscription',
  debug: false,
  defaultAccess: 'protected' as const,
} as const;

