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
  /** Optional plan restriction — tenant plan must be in this list */
  plans?: string[];
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
   * Override the JWKS URL for API token verification.
   * Useful in Docker when the container can't reach the public apiBaseUrl.
   * @default {apiBaseUrl}/auth/account/app/.well-known/jwks.json
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

