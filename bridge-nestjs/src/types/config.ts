/**
 * Feature flag requirement - can be a single flag, any of multiple flags, or all of multiple flags
 */
export type FeatureFlagRequirement =
  | string
  | { any: string[] }
  | { all: string[] };

/**
 * Privilege levels used to protect routes.
 * ANONYMOUS  — no authentication required
 * AUTHENTICATED — any valid JWT (user or API token)
 * USER_READ / USER_WRITE / TENANT_READ / TENANT_WRITE — specific privilege strings
 * that must appear in the user JWT's `privileges` claim.
 */
export type RoutePrivilege =
  | 'ANONYMOUS'
  | 'AUTHENTICATED'
  | 'USER_READ'
  | 'USER_WRITE'
  | 'TENANT_READ'
  | 'TENANT_WRITE'
  | string;

/**
 * Route rule for centralized guard configuration.
 * Provide either `path` (REST) or `graphqlOperation` (GraphQL) — or both.
 */
export interface RouteRule {
  /** REST URL wildcard pattern (e.g. "/account/subscription/**") */
  path?: string;
  /** GraphQL operation name, case-sensitive camelCase (e.g. "listUsers") */
  graphqlOperation?: string;
  /** Required privilege level for this route */
  privilege: RoutePrivilege;
  /**
   * Optional plan restriction (TBP-472). The tenant's subscription plan slug
   * must be in this list, otherwise the request is denied with 402 Payment
   * Required (`reason: 'plan_required'`). Fail-closed: if the plan cannot be
   * resolved the request is denied.
   *
   * ⚠ This gates on the **canonical Billing 2.0 subscription**, resolved via
   * `bridge.fromJwt(jwt).subscription.plan.slug`. That is a different system
   * from the per-app `tenant.plan` and from the JWT `plan` claim, and its
   * slugs are global rather than app-scoped.
   *
   * A workspace with no canonical subscription — for example one created
   * before the Billing 2.0 rollout — resolves no slug and is denied with 402
   * `reason: 'plan_unresolved'`, whatever plan it is actually on. If your app
   * is not on Billing 2.0, `plans:` will reject your entire customer base.
   *
   * For per-app plans, gate on `featureFlag` with a `tenant.plan` targeting
   * rule instead. `privilege`, `featureFlag`, `plans` and `entitlement` sit
   * side by side here and look interchangeable; they are not (TBP-614).
   */
  plans?: string[];
  /**
   * Optional entitlement restriction (TBP-472). Each key is checked via
   * `bridge.fromJwt(jwt).entitlements.can(key)`; the tenant must have ALL
   * listed entitlements, otherwise 402 Payment Required
   * (`reason: 'entitlement_missing'`). Fail-closed on resolution error.
   *
   * ⚠ Same caveat as `plans` above: entitlements come from the canonical
   * Billing 2.0 snapshot, so a workspace without one is denied regardless of
   * what it is entitled to in your app's own model (TBP-614).
   */
  entitlement?: string | string[];
  /**
   * Optional feature-flag restriction (TBP-472). Evaluated for the request's
   * user JWT via the same path as `@RequireFeatureFlag`; a disabled flag
   * denies with 403 Forbidden. Fail-closed on resolution error.
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
}

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
  debug: false,
  defaultAccess: 'protected' as const,
} as const;

