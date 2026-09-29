import { Injectable, Inject } from '@nestjs/common';
import { BridgeConfig, BRIDGE_DEFAULTS, RouteRule, FeatureFlagRequirement } from '../types/config';

export const BRIDGE_CONFIG = Symbol('BRIDGE_CONFIG');

/**
 * Service for accessing Bridge configuration
 */
@Injectable()
export class BridgeConfigService {
  private readonly config: {
    appId: string;
    apiBaseUrl: string;
    debug: boolean;
    guard: BridgeConfig['guard'];
    introspectionUrl: string | undefined;
    introspectionCacheTtlMs: number | undefined;
    userJwksUrl: string | undefined;
    manageRoute: string;
  };

  constructor(@Inject(BRIDGE_CONFIG) config: BridgeConfig) {
    assertRouteRules(config.guard?.rules);
    this.config = {
      appId: config.appId,
      apiBaseUrl: config.apiBaseUrl || BRIDGE_DEFAULTS.apiBaseUrl,
      debug: config.debug ?? BRIDGE_DEFAULTS.debug,
      guard: config.guard,
      introspectionUrl: config.introspectionUrl,
      introspectionCacheTtlMs: config.introspectionCacheTtlMs,
      userJwksUrl: config.userJwksUrl,
      manageRoute: config.billing?.manageRoute || BRIDGE_DEFAULTS.manageRoute,
    };
  }

  get appId(): string {
    return this.config.appId;
  }

  /** Public read of the resolved API base URL (used by the unified BridgeService). */
  get apiBaseUrl(): string {
    return this.config.apiBaseUrl;
  }

  /** Derived: ${apiBaseUrl}/auth — used for JWT issuer validation */
  get authBaseUrl(): string {
    return `${this.config.apiBaseUrl}/auth`;
  }

  /** Derived: ${apiBaseUrl}/cloud-views — used for feature flag evaluation */
  get cloudViewsBaseUrl(): string {
    return `${this.config.apiBaseUrl}/cloud-views`;
  }

  /**
   * TBP-704 — the subscription page a refused request points at (`fix` in
   * 402 `QUOTA_EXCEEDED` / 403 `ENTITLEMENT_REQUIRED` bodies).
   */
  get manageRoute(): string {
    return this.config.manageRoute;
  }

  get debug(): boolean {
    return this.config.debug;
  }

  get isGlobalGuard(): boolean {
    return this.config.guard?.global ?? false;
  }

  get defaultAccess(): 'public' | 'protected' {
    return this.config.guard?.defaultAccess ?? BRIDGE_DEFAULTS.defaultAccess;
  }

  get rules(): RouteRule[] {
    return this.config.guard?.rules ?? [];
  }

  /**
   * JWKS URL for user token verification.
   * Uses userJwksUrl override if configured (for Docker), otherwise derived from apiBaseUrl.
   */
  get jwksUrl(): string {
    return this.config.userJwksUrl ?? `${this.authBaseUrl}/.well-known/jwks.json`;
  }

  /**
   * Token-introspection URL for API token verification (TBP-411).
   *
   * API tokens are HS256-signed with the per-app secret, which this plugin
   * never holds, so they cannot be verified locally. The token is POSTed here
   * and the Bridge answers with its claims — which also gives revocation
   * without any key management on the developer's side.
   *
   * Uses the `introspectionUrl` override if configured, otherwise derived from
   * apiBaseUrl. Note: this lives directly under apiBaseUrl (NOT under /auth).
   */
  get introspectionUrl(): string {
    return this.config.introspectionUrl ?? `${this.apiBaseUrl}/account/api-token/introspect`;
  }

  /**
   * Introspection cache TTL in ms. `0` (the default) introspects on every
   * request, so a revoked token stops working immediately.
   */
  get introspectionCacheTtlMs(): number {
    return this.config.introspectionCacheTtlMs ?? 0;
  }

  /**
   * Find a matching route rule for the given path/method or GraphQL operation name.
   * @param path - the HTTP request path (e.g. '/account/tick')
   * @param method - the HTTP method (e.g. 'GET')
   * @param operationName - optional GraphQL operation name (e.g. 'listUsers')
   */
  findMatchingRule(path: string, method: string, operationName?: string): RouteRule | null {
    for (const rule of this.rules) {
      if (operationName) {
        // GraphQL request: match against graphqlOperation only
        if (rule.graphqlOperation && rule.graphqlOperation === operationName) {
          return rule;
        }
      } else {
        // REST request: match against path only
        if (rule.path && this.pathMatches(path, rule.path)) {
          return rule;
        }
      }
    }
    if (!operationName) this.warnIfPrefixMissed(path);
    return null;
  }

  private readonly prefixWarned = new Set<string>();

  /**
   * TBP-540 — rules match the full request path, including a global prefix
   * (`app.setGlobalPrefix('api')` makes `/health` arrive as `/api/health`).
   * A rule written without the prefix silently never matches, so a public
   * endpoint answers 401. When a rule WOULD match with the first path segment
   * removed, say so once per rule. Behaviour is unchanged.
   */
  private warnIfPrefixMissed(path: string): void {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const segments = normalized.split('/');
    if (segments.length < 3) return;
    const prefix = `/${segments[1]}`;
    const withoutPrefix = `/${segments.slice(2).join('/')}`;
    for (const rule of this.rules) {
      if (!rule.path || this.prefixWarned.has(rule.path)) continue;
      if (this.pathMatches(withoutPrefix, rule.path)) {
        this.prefixWarned.add(rule.path);
        console.warn(
          `[bridge-nestjs] route rule '${rule.path}' did not match '${normalized}'. Rules match the full path, ` +
            `including a global prefix: write '${prefix}${rule.path.startsWith('/') ? '' : '/'}${rule.path}', ` +
            `or put @Public() / @RequireFeatureFlag() on the handler, which follows the route wherever it is mounted.`,
        );
      }
    }
  }

  /**
   * Check if a path matches a pattern (supports * wildcard)
   */
  private pathMatches(path: string, pattern: string): boolean {
    // Normalize paths
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const normalizedPattern = pattern.startsWith('/') ? pattern : `/${pattern}`;

    // Convert pattern to regex
    const regexPattern = normalizedPattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
      .replace(/\\\*/g, '.*'); // Convert * to .*

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(normalizedPath);
  }

  /**
   * Log debug message if debug mode is enabled
   */
  log(message: string, ...args: any[]): void {
    if (this.config.debug) {
      console.log(`[Bridge] ${message}`, ...args);
    }
  }
}


/**
 * TBP-705 — route rules only say whether a route needs a signed-in caller;
 * who gets it is a flag. A rule that still gates on a role, a privilege, a
 * plan or an entitlement fails at startup, naming the flag setup to use
 * instead, rather than being silently ignored (which would open the route).
 */
export function assertRouteRules(rules: unknown): void {
  if (!Array.isArray(rules)) return;
  const problems: string[] = [];
  rules.forEach((raw, i) => {
    const rule = (raw ?? {}) as Record<string, unknown>;
    const where = `guard.rules[${i}]${describeRule(rule)}`;
    const privilege = rule.privilege;
    if (privilege !== 'ANONYMOUS' && privilege !== 'AUTHENTICATED') {
      problems.push(
        `${where} has privilege: ${JSON.stringify(privilege)}. A route rule's privilege is only 'ANONYMOUS' or 'AUTHENTICATED'. ` +
          `Use privilege: 'AUTHENTICATED' with featureFlag: '<flag-key>', and give that flag the rule \`privileges contains ${JSON.stringify(
            typeof privilege === 'string' ? privilege : 'USER_WRITE',
          )}\`. For API-token callers, put @RequirePrivilege(${JSON.stringify(
            typeof privilege === 'string' ? privilege : 'USER_WRITE',
          )}) on the handler (API tokens only).`,
      );
    }
    if ('plans' in rule) {
      problems.push(
        `${where} uses \`plans\`, which was removed. Use featureFlag: '<flag-key>' and give that flag a rule on the plan feature it sells: \`bridge:billing.entitlement.<key> eq true\`.`,
      );
    }
    if ('entitlement' in rule) {
      const keys = ([] as unknown[]).concat(rule.entitlement as unknown[]).filter((k) => typeof k === 'string');
      const key = (keys[0] as string | undefined) ?? '<key>';
      problems.push(
        `${where} uses \`entitlement\`, which was removed. Use featureFlag: '${key}' and give that flag the rule \`bridge:billing.entitlement.${key} eq true\`.`,
      );
    }
    if ('role' in rule || 'roles' in rule) {
      problems.push(
        `${where} uses \`${'role' in rule ? 'role' : 'roles'}\`, which route rules do not support. Use featureFlag: '<flag-key>' and give that flag a rule on a privilege (\`privileges contains "USER_WRITE"\`).`,
      );
    }
  });
  if (problems.length > 0) {
    throw new Error(
      `[bridge-nestjs] Every gate is a flag — these route rules gate some other way:\n  - ${problems.join(
        '\n  - ',
      )}\nRun "npx @nebulr-group/bridge-cli check gates" to list every direct check.`,
    );
  }
}

function describeRule(rule: Record<string, unknown>): string {
  if (typeof rule.path === 'string') return ` (path '${rule.path}')`;
  if (typeof rule.graphqlOperation === 'string') return ` (graphqlOperation '${rule.graphqlOperation}')`;
  return '';
}
