import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { BridgeConfigService } from '../services/bridge-config.service';
import { JwksService, TokenVerificationError, ApiTokenClaims } from '../services/jwks.service';
import { FeatureFlagService } from '../services/feature-flag.service';
import { BridgeService } from '../bridge/bridge.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { REQUIRED_ROLE_KEY } from '../decorators/require-role.decorator';
import { REQUIRED_FEATURE_FLAG_KEY } from '../decorators/require-feature-flag.decorator';
import { REQUIRED_PRIVILEGE_KEY } from '../decorators/require-privilege.decorator';
import { ACCEPT_AUTH_KEY, AuthType } from '../decorators/accept-auth.decorator';
import { transformJwtToBridgeUser, BridgeUser } from '../types/user';
import { transformJwtToBridgeTenant, BridgeTenant } from '../types/tenant';
import { FeatureFlagRequirement, RouteRule } from '../types/config';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      bridgeUser?: BridgeUser;
      bridgeTenant?: BridgeTenant;
      bridgeAccessToken?: string;
      bridgeApiToken?: ApiTokenClaims;
    }
  }
}

/**
 * Maps TokenVerificationError codes to RFC 6750 error strings and descriptions.
 */
const TOKEN_ERROR_MAP: Record<string, { error: string; description: string }> = {
  TOKEN_EXPIRED: {
    error: 'expired_token',
    description: 'The access token has expired',
  },
  TOKEN_INVALID: {
    error: 'invalid_token',
    description: 'The access token is invalid',
  },
  JWKS_NO_MATCH: {
    error: 'invalid_token',
    description: 'The access token signature could not be verified',
  },
  CLAIM_VALIDATION_FAILED: {
    error: 'invalid_token',
    description: 'The access token claim validation failed',
  },
  APP_MISMATCH: {
    error: 'invalid_token',
    description: 'The access token was issued for a different application',
  },
};

/**
 * Body of a 402 Payment Required denial (TBP-472). Dev-friendly: carries an
 * action `reason` plus the specific plan / entitlement that was required.
 */
interface PaymentRequiredBody {
  error: 'Payment required';
  reason: 'plan_required' | 'entitlement_missing' | 'billing_locked';
  requiredPlan?: string;
  requiredEntitlement?: string;
}

/**
 * 402 Payment Required — plan/entitlement gating (TBP-472). NestJS has no
 * built-in exception for this status, so we throw a raw HttpException with a
 * dev-friendly body.
 */
class PaymentRequiredException extends HttpException {
  constructor(body: PaymentRequiredBody) {
    super({ statusCode: HttpStatus.PAYMENT_REQUIRED, ...body }, HttpStatus.PAYMENT_REQUIRED);
  }
}

/**
 * Guard that validates JWT bearer tokens / API tokens and enforces
 * role, feature flag, and privilege requirements.
 *
 * Supports two authentication paths that are evaluated **independently**:
 *
 * 1. **API token path** (x-api-key header):
 *    - If `req.bridgeApiToken` is already set (pre-processed by bridge-api middleware),
 *      the guard trusts it and skips re-verification.
 *    - Otherwise, if x-api-key looks like a JWT, verifies via JWKS and sets
 *      `req.bridgeApiToken`.
 *    - Enforces `@RequirePrivilege` when present; user JWTs bypass this check.
 *
 * 2. **User JWT path** (Authorization: Bearer header):
 *    - Verifies via JWKS (user token endpoint), then sets
 *      `req.bridgeUser`, `req.bridgeTenant`, and `req.bridgeAccessToken`.
 *    - Enforces route-rule privilege (from config) and `@RequireRole`/`@RequireFeatureFlag`.
 *
 * **When both headers are present (e.g. cloud-views always sends both), both paths
 * run and both contexts coexist on `request`.** The guard returns true as long as at
 * least one credential is valid (subject to `@AcceptAuth` and per-credential checks).
 *
 * Returns RFC 6750-compliant WWW-Authenticate headers on 401 responses (HTTP only).
 *
 * Supports both HTTP and GraphQL execution contexts.
 */
@Injectable()
export class BridgeAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: BridgeConfigService,
    private readonly jwksService: JwksService,
    private readonly featureFlagService: FeatureFlagService,
    private readonly bridgeService: BridgeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { request, response, path, method, operationName } = this.extractContext(context);

    this.configService.log(
      `Guard checking: ${method} ${operationName ? `graphql/${operationName}` : path}`,
    );

    // 1. Check if route is public (decorator takes precedence)
    const isPublicDecorator = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublicDecorator) {
      this.configService.log('Route is public (decorator)');
      return true;
    }

    // 2. Check route rules from config
    const matchingRule = this.configService.findMatchingRule(path, method, operationName);

    if (matchingRule?.privilege === 'ANONYMOUS') {
      this.configService.log('Route is public (config rule: ANONYMOUS)', {
        path: matchingRule.path,
        graphqlOperation: matchingRule.graphqlOperation,
      });
      return true;
    }

    // 3. If no rule matches and default is public, allow
    if (!matchingRule && this.configService.defaultAccess === 'public') {
      this.configService.log('Route allowed (default access: public)');
      return true;
    }

    // 4. Read accepted auth type (default: 'both')
    const acceptedType = this.reflector.getAllAndOverride<AuthType>(ACCEPT_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? 'both';

    // 5. Check x-api-key header (API token path)
    const apiKey = request.headers['x-api-key'] as string | undefined;
    const hasAuthHeader = !!request.headers.authorization;
    let apiTokenClaims: ApiTokenClaims | null = null;

    // @AcceptAuth('jwt') semantics: the endpoint requires a user JWT for its
    // user-context decisions. When BOTH headers are present (cloud-views ALWAYS
    // sends both), we accept the request and let the JWT branch populate
    // `request.bridgeUser`. We only reject if the API token is the *only*
    // credential the caller offered.
    if (apiKey && acceptedType === 'jwt' && !hasAuthHeader) {
      this.configService.log('API token rejected — endpoint only accepts user JWTs');
      this.setWwwAuthenticate(
        response,
        'Bearer error="invalid_request", error_description="API token authentication is not accepted for this endpoint"',
      );
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'auth type not accepted',
      });
    }

    // When @AcceptAuth('jwt') and Bearer is present, the API key is informational
    // only — skip API-token verification entirely so its result doesn't trigger
    // privilege checks meant for the JWT path.
    const skipApiTokenForJwtOnly = acceptedType === 'jwt' && hasAuthHeader;

    if (apiKey && !skipApiTokenForJwtOnly) {
      if (request.bridgeApiToken) {
        // a. Pre-processed by bridge-api middleware — trust it, skip re-verification
        apiTokenClaims = request.bridgeApiToken;
        this.configService.log('API token pre-processed by middleware', {
          appId: apiTokenClaims!.appId,
        });
      } else if (this.isJwtShaped(apiKey)) {
        // b. Standalone verification (customer NestJS apps)
        try {
          apiTokenClaims = await this.jwksService.verifyApiToken(
            apiKey,
            this.configService.appId,
          );
          request.bridgeApiToken = apiTokenClaims;
          this.configService.log('API token verified', { appId: apiTokenClaims.appId });
        } catch (error) {
          if (error instanceof TokenVerificationError) {
            this.configService.log('API token verification failed', { code: error.code });
            const mapped = TOKEN_ERROR_MAP[error.code] ?? {
              error: 'invalid_token',
              description: 'The access token is invalid',
            };
            this.setWwwAuthenticate(
              response,
              `Bearer error="${mapped.error}", error_description="${mapped.description}"`,
            );
            throw new UnauthorizedException({
              statusCode: 401,
              error: 'Unauthorized',
              message: mapped.description,
            });
          }
          this.setWwwAuthenticate(
            response,
            'Bearer error="invalid_token", error_description="The access token is invalid"',
          );
          throw new UnauthorizedException({
            statusCode: 401,
            error: 'Unauthorized',
            message: 'Access token missing or invalid',
          });
        }
      }
      // c. else: non-JWT key (opaque) — no API token context, fall through to Authorization
    }

    // 6. User JWT path — extract and validate Authorization: Bearer token
    //
    // Independent from the API-token path: when both credentials are present
    // and valid, both contexts coexist on `request` (bridgeApiToken AND
    // bridgeUser/bridgeTenant/bridgeAccessToken). cloud-views and other
    // first-party Bridge frontends rely on this — they always send both.
    const authHeader = request.headers.authorization;
    let user: BridgeUser | null = null;
    let token: string | null = null;

    if (authHeader && acceptedType === 'api_token') {
      this.configService.log('User JWT rejected — endpoint only accepts API tokens');
      this.setWwwAuthenticate(
        response,
        'Bearer error="invalid_request", error_description="User JWT authentication is not accepted for this endpoint"',
      );
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'auth type not accepted',
      });
    }

    if (authHeader) {
      token = this.extractToken(request);
      if (!token) {
        this.configService.log('Authorization header present but malformed');
        this.setWwwAuthenticate(
          response,
          'Bearer error="invalid_token", error_description="The access token is invalid"',
        );
        throw new UnauthorizedException({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Access token missing or invalid',
        });
      }

      let claims;
      try {
        claims = await this.jwksService.verifyToken(token);
      } catch (error) {
        if (error instanceof TokenVerificationError) {
          this.configService.log('Token verification failed', { code: error.code });
          const mapped = TOKEN_ERROR_MAP[error.code] ?? {
            error: 'invalid_token',
            description: 'The access token is invalid',
          };
          this.setWwwAuthenticate(
            response,
            `Bearer error="${mapped.error}", error_description="${mapped.description}"`,
          );
          throw new UnauthorizedException({
            statusCode: 401,
            error: 'Unauthorized',
            message: mapped.description,
          });
        }
        this.setWwwAuthenticate(
          response,
          'Bearer error="invalid_token", error_description="The access token is invalid"',
        );
        throw new UnauthorizedException({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Access token missing or invalid',
        });
      }

      // Attach user and tenant to request
      user = transformJwtToBridgeUser(claims);
      const tenant = transformJwtToBridgeTenant(claims);

      request.bridgeUser = user;
      request.bridgeTenant = tenant || undefined;
      request.bridgeAccessToken = token;

      this.configService.log('User authenticated', { userId: user.id, tenantId: user.tenantId });
    }

    // 7. Require at least one valid credential
    if (!apiTokenClaims && !user) {
      this.configService.log('No Authorization header');
      this.setWwwAuthenticate(
        response,
        'Bearer error="missing_token", error_description="No authorization token was provided"',
      );
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'No authorization token was provided',
      });
    }

    // 8. API-token privilege check (@RequirePrivilege) — applies when API
    //    token is present. User JWTs bypass @RequirePrivilege (existing
    //    backward-compat behavior); they are governed by @RequireRole,
    //    @RequireFeatureFlag and route-rule privilege below.
    if (apiTokenClaims) {
      const requiredPrivilege = this.getRequiredPrivilege(context);
      if (requiredPrivilege) {
        const privileges = apiTokenClaims.privileges ?? [];
        if (!privileges.includes(requiredPrivilege)) {
          this.configService.log('Privilege check failed', {
            required: requiredPrivilege,
            actual: privileges,
          });
          throw new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            message: `Privilege '${requiredPrivilege}' required`,
          });
        }
        this.configService.log('Privilege check passed', { privilege: requiredPrivilege });
      }
    }

    // 9. User-JWT-only checks (route rule privilege, role, feature flag)
    if (user) {
      // Route-rule privilege for user JWT
      const rulePrivilege = matchingRule?.privilege;
      if (rulePrivilege && rulePrivilege !== 'ANONYMOUS' && rulePrivilege !== 'AUTHENTICATED') {
        const userPrivileges = user.privileges ?? [];
        if (!userPrivileges.includes(rulePrivilege)) {
          this.configService.log('Route privilege check failed', {
            required: rulePrivilege,
            actual: userPrivileges,
          });
          throw new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            message: `Privilege '${rulePrivilege}' required`,
          });
        }
        this.configService.log('Route privilege check passed', { privilege: rulePrivilege });
      }

      // Role requirement (decorator only) — user JWT only
      const requiredRole = this.getRequiredRole(context);
      if (requiredRole) {
        if (user.role !== requiredRole) {
          this.configService.log('Role check failed', {
            required: requiredRole,
            actual: user.role,
          });
          throw new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            message: `Role '${requiredRole}' required`,
          });
        }
        this.configService.log('Role check passed', { role: requiredRole });
      }

      // Feature flag requirement (decorator only) — user JWT only
      const requiredFlag = this.getRequiredFeatureFlag(context);
      if (requiredFlag && token) {
        const flagEnabled = await this.featureFlagService.evaluateRequirement(requiredFlag, token);
        if (!flagEnabled) {
          const flagName =
            typeof requiredFlag === 'string' ? requiredFlag : JSON.stringify(requiredFlag);
          this.configService.log('Feature flag check failed', { flag: flagName });
          throw new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            message: `Feature flag '${flagName}' is not enabled`,
          });
        }
        this.configService.log('Feature flag check passed', { flag: requiredFlag });
      }

      // Route-rule gating (TBP-472): feature flag (403), then plan and
      // entitlement (402). Only user JWTs carry the tenant/subscription
      // context these checks need, so they run in the user branch and require
      // the access token to resolve the snapshot / evaluate flags.
      if (matchingRule && token) {
        await this.enforceRouteRuleGating(matchingRule, token);
      }
    }

    return true;
  }

  /**
   * Enforce the TBP-472 route-rule conditions for a user JWT:
   *   - `featureFlag` → 403 Forbidden when disabled (reuses FeatureFlagService,
   *     the same eval path as `@RequireFeatureFlag`).
   *   - `plans` → 402 Payment Required (`plan_required`) when the tenant's
   *     subscription plan slug is not in the allow-list.
   *   - `entitlement` → 402 Payment Required (`entitlement_missing`) when any
   *     required entitlement key is not granted.
   *
   * Fail-closed: any error resolving the subscription/entitlements/flag denies
   * the request (402 `billing_locked` for plan/entitlement resolution errors,
   * 403 for flag-evaluation errors).
   */
  private async enforceRouteRuleGating(rule: RouteRule, token: string): Promise<void> {
    // 1. Feature flag (403). Reuses the decorator eval path.
    if (rule.featureFlag) {
      let flagEnabled: boolean;
      try {
        flagEnabled = await this.featureFlagService.evaluateRequirement(rule.featureFlag, token);
      } catch (error) {
        // Fail-closed: undeterminable flag → deny.
        this.configService.log('Route feature flag evaluation error — denying (fail-closed)', {
          error,
        });
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Feature flag could not be evaluated',
        });
      }
      if (!flagEnabled) {
        const flagName =
          typeof rule.featureFlag === 'string'
            ? rule.featureFlag
            : JSON.stringify(rule.featureFlag);
        this.configService.log('Route feature flag check failed', { flag: flagName });
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          message: `Feature flag '${flagName}' is not enabled`,
        });
      }
      this.configService.log('Route feature flag check passed');
    }

    const needsPlan = Array.isArray(rule.plans) && rule.plans.length > 0;
    const requiredEntitlements = this.normalizeEntitlements(rule.entitlement);
    const needsEntitlement = requiredEntitlements.length > 0;

    if (!needsPlan && !needsEntitlement) {
      return;
    }

    // 2 & 3. Plan + entitlement both read the tenant snapshot (one round-trip,
    // shared via BridgePullCache). Fail-closed: snapshot resolution error → 402.
    const tenant = this.bridgeService.fromJwt(token);

    if (needsPlan) {
      let planSlug: string;
      try {
        const subscription = await tenant.subscription;
        planSlug = subscription?.plan?.slug ?? '';
      } catch (error) {
        this.configService.log('Subscription resolution error — denying (fail-closed)', { error });
        throw new PaymentRequiredException({
          error: 'Payment required',
          reason: 'billing_locked',
        });
      }
      if (!planSlug || !rule.plans!.includes(planSlug)) {
        this.configService.log('Route plan check failed', {
          required: rule.plans,
          actual: planSlug,
        });
        throw new PaymentRequiredException({
          error: 'Payment required',
          reason: 'plan_required',
          requiredPlan: rule.plans!.join(', '),
        });
      }
      this.configService.log('Route plan check passed', { plan: planSlug });
    }

    if (needsEntitlement) {
      for (const key of requiredEntitlements) {
        let granted: boolean;
        try {
          granted = await tenant.entitlements.can(key);
        } catch (error) {
          this.configService.log('Entitlement resolution error — denying (fail-closed)', {
            error,
            key,
          });
          throw new PaymentRequiredException({
            error: 'Payment required',
            reason: 'billing_locked',
            requiredEntitlement: key,
          });
        }
        if (!granted) {
          this.configService.log('Route entitlement check failed', { required: key });
          throw new PaymentRequiredException({
            error: 'Payment required',
            reason: 'entitlement_missing',
            requiredEntitlement: key,
          });
        }
      }
      this.configService.log('Route entitlement check passed', { entitlements: requiredEntitlements });
    }
  }

  /** Normalize `entitlement?: string | string[]` to a string[] (all required). */
  private normalizeEntitlements(entitlement: string | string[] | undefined): string[] {
    if (!entitlement) return [];
    return Array.isArray(entitlement) ? entitlement.filter(Boolean) : [entitlement];
  }

  /**
   * Extract request, response and resource info from an HTTP or GraphQL context.
   * For GraphQL, response is null (WWW-Authenticate headers are not applicable).
   * GraphQL args order: [root, args, context, info]
   */
  private extractContext(context: ExecutionContext): {
    request: Request;
    response: Response | null;
    path: string;
    method: string;
    operationName?: string;
  } {
    const type = context.getType<string>();

    if (type === 'graphql') {
      // GQL execution context args: [root, args, gqlContext, info]
      const gqlContext = context.getArgByIndex(2) as any;
      const info = context.getArgByIndex(3) as any;
      const request = (gqlContext?.req ?? gqlContext) as Request;
      const operationName = info?.fieldName as string | undefined;
      return { request, response: null, path: '/graphql', method: 'POST', operationName };
    }

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    return { request, response, path: request.path, method: request.method };
  }

  /**
   * Set WWW-Authenticate header on the response (no-op for GraphQL).
   */
  private setWwwAuthenticate(response: Response | null, value: string): void {
    response?.setHeader('WWW-Authenticate', value);
  }

  /**
   * Detect JWT shape: 3 non-empty base64url segments separated by dots.
   */
  private isJwtShaped(token: string): boolean {
    if (!token) return false;
    const parts = token.split('.');
    return parts.length === 3 && parts.every((p) => p.length > 0);
  }

  /**
   * Extract bearer token from Authorization header
   */
  private extractToken(request: Request): string | null {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      return null;
    }

    const [type, token] = authHeader.split(' ');
    if (type.toLowerCase() !== 'bearer' || !token) {
      return null;
    }

    return token;
  }

  /**
   * Get required privilege from @RequirePrivilege decorator (API token path)
   */
  private getRequiredPrivilege(context: ExecutionContext): string | undefined {
    return this.reflector.getAllAndOverride<string>(REQUIRED_PRIVILEGE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
  }

  /**
   * Get required role from @RequireRole decorator (user JWT path)
   */
  private getRequiredRole(context: ExecutionContext): string | undefined {
    return this.reflector.getAllAndOverride<string>(REQUIRED_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
  }

  /**
   * Get required feature flag from @RequireFeatureFlag decorator (user JWT path)
   */
  private getRequiredFeatureFlag(
    context: ExecutionContext,
  ): FeatureFlagRequirement | undefined {
    return this.reflector.getAllAndOverride<FeatureFlagRequirement>(
      REQUIRED_FEATURE_FLAG_KEY,
      [context.getHandler(), context.getClass()],
    );
  }
}
