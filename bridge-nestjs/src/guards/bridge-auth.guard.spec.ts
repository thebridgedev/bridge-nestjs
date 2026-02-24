import 'reflect-metadata';

// jose is ESM-only; mock it so CJS jest can load the module graph
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
  errors: {
    JWTExpired: class extends Error {},
    JWTInvalid: class extends Error {},
    JWKSNoMatchingKey: class extends Error {},
    JWTClaimValidationFailed: class extends Error {},
  },
}));

import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BridgeAuthGuard } from './bridge-auth.guard';
import { BridgeConfigService } from '../services/bridge-config.service';
import { JwksService, TokenVerificationError } from '../services/jwks.service';
import { FeatureFlagService } from '../services/feature-flag.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { REQUIRED_ROLE_KEY } from '../decorators/require-role.decorator';
import { REQUIRED_FEATURE_FLAG_KEY } from '../decorators/require-feature-flag.decorator';

// Minimal JWT claims for testing
const mockClaims = {
  sub: 'user-1',
  email: 'test@example.com',
  email_verified: true,
  preferred_username: 'test',
  name: 'Test User',
  tid: 'tenant-1',
  role: 'USER',
};

function makeContext(overrides: {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  isPublicDecorator?: boolean;
  requiredRole?: string;
  requiredFlag?: any;
}): ExecutionContext {
  const request: any = {
    path: overrides.path ?? '/items',
    method: overrides.method ?? 'GET',
    headers: overrides.headers ?? {},
  };
  const response: any = {
    _headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this._headers[name] = value;
    },
  };

  const handler = jest.fn();
  const classRef = jest.fn();

  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    getHandler: () => handler,
    getClass: () => classRef,
  } as unknown as ExecutionContext;

  return context;
}

describe('BridgeAuthGuard', () => {
  let guard: BridgeAuthGuard;
  let reflector: jest.Mocked<Reflector>;
  let configService: jest.Mocked<BridgeConfigService>;
  let jwksService: jest.Mocked<JwksService>;
  let featureFlagService: jest.Mocked<FeatureFlagService>;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as any;

    configService = {
      log: jest.fn(),
      findMatchingRule: jest.fn().mockReturnValue(null),
      defaultAccess: 'protected',
    } as any;

    jwksService = {
      verifyToken: jest.fn(),
    } as any;

    featureFlagService = {
      evaluateRequirement: jest.fn(),
    } as any;

    guard = new BridgeAuthGuard(reflector, configService, jwksService, featureFlagService);
  });

  describe('public routes', () => {
    it('should allow public route via @Public() decorator', async () => {
      reflector.getAllAndOverride.mockReturnValueOnce(true); // IS_PUBLIC_KEY
      const ctx = makeContext({});
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(jwksService.verifyToken).not.toHaveBeenCalled();
    });

    it('should allow public route via config rule', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      configService.findMatchingRule.mockReturnValue({ path: '/health', public: true });
      const ctx = makeContext({ path: '/health' });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(jwksService.verifyToken).not.toHaveBeenCalled();
    });

    it('should allow access when defaultAccess is public and no rule matches', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      configService.findMatchingRule.mockReturnValue(null);
      (configService as any).defaultAccess = 'public';
      const ctx = makeContext({});
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(jwksService.verifyToken).not.toHaveBeenCalled();
    });
  });

  describe('missing token', () => {
    it('should throw UnauthorizedException with missing_token when no Authorization header', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      configService.findMatchingRule.mockReturnValue(null);

      const ctx = makeContext({ headers: {} });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);

      const req = ctx.switchToHttp().getRequest();
      const res = ctx.switchToHttp().getResponse() as any;
      expect(res._headers['WWW-Authenticate']).toContain('missing_token');
    });
  });

  describe('token verification errors', () => {
    it('should throw UnauthorizedException with expired_token when token is expired', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      configService.findMatchingRule.mockReturnValue(null);
      jwksService.verifyToken.mockRejectedValue(
        new TokenVerificationError('Token expired', 'TOKEN_EXPIRED'),
      );

      const ctx = makeContext({ headers: { authorization: 'Bearer expired.token.here' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);

      const res = ctx.switchToHttp().getResponse() as any;
      expect(res._headers['WWW-Authenticate']).toContain('expired_token');
    });

    it('should throw UnauthorizedException with invalid_token when token is invalid', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      configService.findMatchingRule.mockReturnValue(null);
      jwksService.verifyToken.mockRejectedValue(
        new TokenVerificationError('Invalid token', 'TOKEN_INVALID'),
      );

      const ctx = makeContext({ headers: { authorization: 'Bearer tampered.token.here' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);

      const res = ctx.switchToHttp().getResponse() as any;
      expect(res._headers['WWW-Authenticate']).toContain('invalid_token');
    });

    it('should throw UnauthorizedException with invalid_token when JWKS has no matching key', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      configService.findMatchingRule.mockReturnValue(null);
      jwksService.verifyToken.mockRejectedValue(
        new TokenVerificationError('No matching key', 'JWKS_NO_MATCH'),
      );

      const ctx = makeContext({ headers: { authorization: 'Bearer some.token.here' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);

      const res = ctx.switchToHttp().getResponse() as any;
      expect(res._headers['WWW-Authenticate']).toContain('invalid_token');
    });
  });

  describe('valid token', () => {
    it('should attach bridgeUser, bridgeTenant, and bridgeAccessToken to request on valid token', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      configService.findMatchingRule.mockReturnValue(null);
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const ctx = makeContext({ headers: { authorization: 'Bearer valid.token.here' } });
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      const req = ctx.switchToHttp().getRequest() as any;
      expect(req.bridgeUser).toBeDefined();
      expect(req.bridgeUser.id).toBe('user-1');
      expect(req.bridgeAccessToken).toBe('valid.token.here');
    });
  });

  describe('role checks', () => {
    it('should throw ForbiddenException if user role does not match required role from config', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      configService.findMatchingRule.mockReturnValue({ path: '/admin/*', role: 'ADMIN' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any); // role: 'USER'

      const ctx = makeContext({ path: '/admin/users', headers: { authorization: 'Bearer token' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });

    it('should use decorator role when it overrides config role', async () => {
      // Config has ADMIN, decorator overrides to OWNER — user has USER role
      reflector.getAllAndOverride
        .mockReturnValueOnce(undefined) // IS_PUBLIC_KEY
        .mockReturnValueOnce('OWNER'); // REQUIRED_ROLE_KEY
      configService.findMatchingRule.mockReturnValue({ path: '/admin/*', role: 'ADMIN' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const ctx = makeContext({ path: '/admin/settings', headers: { authorization: 'Bearer token' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });

    it('should pass when user role matches required role', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      configService.findMatchingRule.mockReturnValue({ path: '/admin/*', role: 'USER' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const ctx = makeContext({ path: '/admin/users', headers: { authorization: 'Bearer token' } });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });
  });

  describe('feature flag checks', () => {
    it('should delegate to FeatureFlagService when feature flag is required', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      configService.findMatchingRule.mockReturnValue({ path: '/beta/*', featureFlag: 'beta-access' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      featureFlagService.evaluateRequirement.mockResolvedValue(true);

      const ctx = makeContext({ path: '/beta/feature', headers: { authorization: 'Bearer token' } });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(featureFlagService.evaluateRequirement).toHaveBeenCalledWith('beta-access', 'token');
    });

    it('should throw ForbiddenException when feature flag is disabled', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      configService.findMatchingRule.mockReturnValue({ path: '/beta/*', featureFlag: 'beta-access' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      featureFlagService.evaluateRequirement.mockResolvedValue(false);

      const ctx = makeContext({ path: '/beta/feature', headers: { authorization: 'Bearer token' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });
  });
});
