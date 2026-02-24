import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { BridgeConfigService } from '../services/bridge-config.service';
import { JwksService, TokenVerificationError } from '../services/jwks.service';
import { FeatureFlagService } from '../services/feature-flag.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { REQUIRED_ROLE_KEY } from '../decorators/require-role.decorator';
import { REQUIRED_FEATURE_FLAG_KEY } from '../decorators/require-feature-flag.decorator';
import { transformJwtToBridgeUser, BridgeUser } from '../types/user';
import { transformJwtToBridgeTenant, BridgeTenant } from '../types/tenant';
import { FeatureFlagRequirement } from '../types/config';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      bridgeUser?: BridgeUser;
      bridgeTenant?: BridgeTenant;
      bridgeAccessToken?: string;
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
};

/**
 * Guard that validates JWT bearer tokens and enforces role/feature flag requirements.
 *
 * Returns RFC 6750-compliant WWW-Authenticate headers on 401 responses so clients
 * can distinguish between missing, expired, and invalid tokens.
 *
 * Can be used:
 * - Per-route: @UseGuards(BridgeAuthGuard)
 * - Per-controller: @UseGuards(BridgeAuthGuard) on controller class
 * - Globally: via BridgeModule.forRoot({ guard: { global: true } })
 */
@Injectable()
export class BridgeAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: BridgeConfigService,
    private readonly jwksService: JwksService,
    private readonly featureFlagService: FeatureFlagService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const path = request.path;
    const method = request.method;

    this.configService.log(`Guard checking: ${method} ${path}`);

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
    const matchingRule = this.configService.findMatchingRule(path, method);

    if (matchingRule?.public) {
      this.configService.log('Route is public (config rule)', { path: matchingRule.path });
      return true;
    }

    // 3. If no rule matches and default is public, allow
    if (!matchingRule && this.configService.defaultAccess === 'public') {
      this.configService.log('Route allowed (default access: public)');
      return true;
    }

    // 4. Extract and validate token
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      this.configService.log('No Authorization header');
      response.setHeader(
        'WWW-Authenticate',
        'Bearer error="missing_token", error_description="No authorization token was provided"',
      );
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'No authorization token was provided',
      });
    }

    const token = this.extractToken(request);
    if (!token) {
      this.configService.log('Authorization header present but malformed');
      response.setHeader(
        'WWW-Authenticate',
        'Bearer error="invalid_token", error_description="The access token is invalid"',
      );
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Access token missing or invalid',
      });
    }

    // 5. Verify JWT
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
        response.setHeader(
          'WWW-Authenticate',
          `Bearer error="${mapped.error}", error_description="${mapped.description}"`,
        );
        throw new UnauthorizedException({
          statusCode: 401,
          error: 'Unauthorized',
          message: mapped.description,
        });
      }
      response.setHeader(
        'WWW-Authenticate',
        'Bearer error="invalid_token", error_description="The access token is invalid"',
      );
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Access token missing or invalid',
      });
    }

    // 6. Attach user and tenant to request
    const user = transformJwtToBridgeUser(claims);
    const tenant = transformJwtToBridgeTenant(claims);

    request.bridgeUser = user;
    request.bridgeTenant = tenant || undefined;
    request.bridgeAccessToken = token;

    this.configService.log('User authenticated', { userId: user.id, tenantId: user.tenantId });

    // 7. Check role requirement (decorator overrides config)
    const requiredRole = this.getRequiredRole(context, matchingRule?.role);
    if (requiredRole) {
      if (user.role !== requiredRole) {
        this.configService.log('Role check failed', { required: requiredRole, actual: user.role });
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          message: `Role '${requiredRole}' required`,
        });
      }
      this.configService.log('Role check passed', { role: requiredRole });
    }

    // 8. Check feature flag requirement (decorator overrides config)
    const requiredFlag = this.getRequiredFeatureFlag(context, matchingRule?.featureFlag);
    if (requiredFlag) {
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

    return true;
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
   * Get required role (decorator overrides config)
   */
  private getRequiredRole(context: ExecutionContext, configRole?: string): string | undefined {
    // Check for decorator (method first, then class)
    const decoratorRole = this.reflector.getAllAndOverride<string>(REQUIRED_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Decorator takes precedence
    if (decoratorRole !== undefined) {
      return decoratorRole;
    }

    return configRole;
  }

  /**
   * Get required feature flag (decorator overrides config)
   */
  private getRequiredFeatureFlag(
    context: ExecutionContext,
    configFlag?: FeatureFlagRequirement,
  ): FeatureFlagRequirement | undefined {
    // Check for decorator (method first, then class)
    const decoratorFlag = this.reflector.getAllAndOverride<FeatureFlagRequirement>(
      REQUIRED_FEATURE_FLAG_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Decorator takes precedence
    if (decoratorFlag !== undefined) {
      return decoratorFlag;
    }

    return configFlag;
  }
}
