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
import { REQUIRED_PRIVILEGE_KEY } from '../decorators/require-privilege.decorator';
import { ACCEPT_AUTH_KEY } from '../decorators/accept-auth.decorator';
import type { ApiTokenClaims } from '../services/jwks.service';

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
  bridgeApiToken?: ApiTokenClaims;
}): ExecutionContext {
  const request: any = {
    path: overrides.path ?? '/items',
    method: overrides.method ?? 'GET',
    headers: overrides.headers ?? {},
    bridgeApiToken: overrides.bridgeApiToken,
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
    getType: () => 'http',
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
      appId: 'test-app-id',
    } as any;

    jwksService = {
      verifyToken: jest.fn(),
      verifyApiToken: jest.fn(),
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
      configService.findMatchingRule.mockReturnValue({ path: '/health', privilege: 'ANONYMOUS' });
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

  describe('privilege checks from route rules', () => {
    it('should throw ForbiddenException when user lacks required privilege', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      configService.findMatchingRule.mockReturnValue({ path: '/admin/*', privilege: 'TENANT_WRITE' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any); // no privileges

      const ctx = makeContext({ path: '/admin/users', headers: { authorization: 'Bearer token' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });

    it('should pass when user has required privilege', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      configService.findMatchingRule.mockReturnValue({ path: '/admin/*', privilege: 'TENANT_WRITE' });
      jwksService.verifyToken.mockResolvedValue({ ...mockClaims, privileges: ['TENANT_WRITE'] } as any);

      const ctx = makeContext({ path: '/admin/users', headers: { authorization: 'Bearer token' } });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('should allow AUTHENTICATED privilege for any valid JWT', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      configService.findMatchingRule.mockReturnValue({ path: '/admin/*', privilege: 'AUTHENTICATED' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const ctx = makeContext({ path: '/admin/users', headers: { authorization: 'Bearer token' } });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });
  });

  describe('role checks (decorator)', () => {
    it('should throw ForbiddenException when user role does not match decorator role', async () => {
      reflector.getAllAndOverride
        .mockReturnValueOnce(undefined) // IS_PUBLIC_KEY
        .mockReturnValueOnce(undefined) // ACCEPT_AUTH_KEY
        .mockReturnValueOnce('ADMIN');  // REQUIRED_ROLE_KEY
      configService.findMatchingRule.mockReturnValue({ path: '/admin/*', privilege: 'AUTHENTICATED' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any); // role: 'USER'

      const ctx = makeContext({ path: '/admin/settings', headers: { authorization: 'Bearer token' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });

    it('should pass when user role matches decorator role', async () => {
      reflector.getAllAndOverride
        .mockReturnValueOnce(undefined) // IS_PUBLIC_KEY
        .mockReturnValueOnce(undefined) // ACCEPT_AUTH_KEY
        .mockReturnValueOnce('USER');   // REQUIRED_ROLE_KEY
      configService.findMatchingRule.mockReturnValue({ path: '/admin/*', privilege: 'AUTHENTICATED' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any); // role: 'USER'

      const ctx = makeContext({ path: '/admin/users', headers: { authorization: 'Bearer token' } });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });
  });

  describe('feature flag checks (decorator)', () => {
    it('should delegate to FeatureFlagService when flag decorator is present', async () => {
      reflector.getAllAndOverride
        .mockReturnValueOnce(undefined)      // IS_PUBLIC_KEY
        .mockReturnValueOnce(undefined)      // ACCEPT_AUTH_KEY
        .mockReturnValueOnce(undefined)      // REQUIRED_ROLE_KEY
        .mockReturnValueOnce('beta-access'); // REQUIRED_FEATURE_FLAG_KEY
      configService.findMatchingRule.mockReturnValue({ path: '/beta/*', privilege: 'AUTHENTICATED' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      featureFlagService.evaluateRequirement.mockResolvedValue(true);

      const ctx = makeContext({ path: '/beta/feature', headers: { authorization: 'Bearer token' } });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(featureFlagService.evaluateRequirement).toHaveBeenCalledWith('beta-access', 'token');
    });

    it('should throw ForbiddenException when feature flag is disabled', async () => {
      reflector.getAllAndOverride
        .mockReturnValueOnce(undefined)      // IS_PUBLIC_KEY
        .mockReturnValueOnce(undefined)      // ACCEPT_AUTH_KEY
        .mockReturnValueOnce(undefined)      // REQUIRED_ROLE_KEY
        .mockReturnValueOnce('beta-access'); // REQUIRED_FEATURE_FLAG_KEY
      configService.findMatchingRule.mockReturnValue({ path: '/beta/*', privilege: 'AUTHENTICATED' });
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);
      featureFlagService.evaluateRequirement.mockResolvedValue(false);

      const ctx = makeContext({ path: '/beta/feature', headers: { authorization: 'Bearer token' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('API token path (x-api-key)', () => {
    const mockApiTokenClaims: ApiTokenClaims = {
      sub: 'token-1',
      appId: 'test-app-id',
      tenantId: null,
      type: 'api',
      privileges: ['USER_READ', 'TENANT_READ'],
    };

    it('valid API token → 200, req.bridgeApiToken populated', async () => {
      // IS_PUBLIC_KEY → undefined, REQUIRED_PRIVILEGE_KEY → undefined
      reflector.getAllAndOverride.mockReturnValue(undefined);
      jwksService.verifyApiToken.mockResolvedValue(mockApiTokenClaims);

      const ctx = makeContext({ headers: { 'x-api-key': 'valid.api.token' } });
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      const req = ctx.switchToHttp().getRequest() as any;
      expect(req.bridgeApiToken).toEqual(mockApiTokenClaims);
    });

    it('token appId !== config.appId → 401 (APP_MISMATCH)', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      jwksService.verifyApiToken.mockRejectedValue(
        new TokenVerificationError('Token issued for a different app', 'APP_MISMATCH'),
      );

      const ctx = makeContext({ headers: { 'x-api-key': 'wrong.app.token' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);

      const res = ctx.switchToHttp().getResponse() as any;
      expect(res._headers['WWW-Authenticate']).toContain('invalid_token');
    });

    it('tampered signature → 401', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      jwksService.verifyApiToken.mockRejectedValue(
        new TokenVerificationError('Invalid token signature', 'JWKS_NO_MATCH'),
      );

      const ctx = makeContext({ headers: { 'x-api-key': 'tampered.api.token' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('expired token → 401 (TOKEN_EXPIRED)', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      jwksService.verifyApiToken.mockRejectedValue(
        new TokenVerificationError('Token expired', 'TOKEN_EXPIRED'),
      );

      const ctx = makeContext({ headers: { 'x-api-key': 'expired.api.token' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);

      const res = ctx.switchToHttp().getResponse() as any;
      expect(res._headers['WWW-Authenticate']).toContain('expired_token');
    });

    it('wrong type claim → 401 (TOKEN_INVALID)', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      jwksService.verifyApiToken.mockRejectedValue(
        new TokenVerificationError('Wrong token type', 'TOKEN_INVALID'),
      );

      const ctx = makeContext({ headers: { 'x-api-key': 'user.jwt.token' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('@RequirePrivilege present, privilege in token → 200', async () => {
      reflector.getAllAndOverride
        .mockReturnValueOnce(undefined) // IS_PUBLIC_KEY
        .mockReturnValueOnce(undefined) // ACCEPT_AUTH_KEY
        .mockReturnValueOnce('USER_READ'); // REQUIRED_PRIVILEGE_KEY
      jwksService.verifyApiToken.mockResolvedValue(mockApiTokenClaims);

      const ctx = makeContext({ headers: { 'x-api-key': 'valid.api.token' } });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('@RequirePrivilege present, privilege missing → 403', async () => {
      reflector.getAllAndOverride
        .mockReturnValueOnce(undefined) // IS_PUBLIC_KEY
        .mockReturnValueOnce(undefined) // ACCEPT_AUTH_KEY
        .mockReturnValueOnce('ADMIN_WRITE'); // not in token
      jwksService.verifyApiToken.mockResolvedValue(mockApiTokenClaims);

      const ctx = makeContext({ headers: { 'x-api-key': 'valid.api.token' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });

    it('@RequirePrivilege present, empty privileges array → 403', async () => {
      reflector.getAllAndOverride
        .mockReturnValueOnce(undefined) // IS_PUBLIC_KEY
        .mockReturnValueOnce(undefined) // ACCEPT_AUTH_KEY
        .mockReturnValueOnce('USER_READ');
      jwksService.verifyApiToken.mockResolvedValue({
        ...mockApiTokenClaims,
        privileges: [],
      });

      const ctx = makeContext({ headers: { 'x-api-key': 'valid.api.token' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });

    it('no @RequirePrivilege → 200 (privilege check skipped)', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined); // all metadata calls return undefined
      jwksService.verifyApiToken.mockResolvedValue(mockApiTokenClaims);

      const ctx = makeContext({ headers: { 'x-api-key': 'valid.api.token' } });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('user JWT + @RequirePrivilege → 200 (backward compat, privilege check skipped for user tokens)', async () => {
      reflector.getAllAndOverride
        .mockReturnValueOnce(undefined) // IS_PUBLIC_KEY
        .mockReturnValueOnce(undefined) // ACCEPT_AUTH_KEY
        .mockReturnValueOnce(undefined) // REQUIRED_ROLE_KEY (no API token → REQUIRED_PRIVILEGE_KEY not checked)
        .mockReturnValueOnce(undefined); // REQUIRED_FEATURE_FLAG_KEY
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      // No x-api-key → falls through to user JWT path
      const ctx = makeContext({ headers: { authorization: 'Bearer user.jwt.token' } });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      // verifyApiToken should NOT have been called
      expect(jwksService.verifyApiToken).not.toHaveBeenCalled();
    });

    it('pre-processed req.bridgeApiToken already set → guard uses it, does NOT call verifyApiToken', async () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);

      const ctx = makeContext({
        headers: { 'x-api-key': 'pre.processed.token' },
        bridgeApiToken: mockApiTokenClaims,
      });
      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(jwksService.verifyApiToken).not.toHaveBeenCalled();
    });
  });

  describe('@AcceptAuth decorator', () => {
    const mockApiTokenClaims: ApiTokenClaims = {
      sub: 'token-1',
      appId: 'test-app-id',
      tenantId: null,
      type: 'api',
      privileges: ['USER_READ'],
    };

    it('@AcceptAuth("jwt") + API token (x-api-key) → 401', async () => {
      reflector.getAllAndOverride
        .mockReturnValueOnce(undefined) // IS_PUBLIC_KEY
        .mockReturnValueOnce('jwt');    // ACCEPT_AUTH_KEY

      const ctx = makeContext({ headers: { 'x-api-key': 'valid.api.token' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);

      const res = ctx.switchToHttp().getResponse() as any;
      expect(res._headers['WWW-Authenticate']).toContain('invalid_request');
      expect(jwksService.verifyApiToken).not.toHaveBeenCalled();
    });

    it('@AcceptAuth("api_token") + user JWT (Authorization Bearer) → 401', async () => {
      reflector.getAllAndOverride
        .mockReturnValueOnce(undefined)    // IS_PUBLIC_KEY
        .mockReturnValueOnce('api_token'); // ACCEPT_AUTH_KEY

      const ctx = makeContext({ headers: { authorization: 'Bearer user.jwt.token' } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);

      const res = ctx.switchToHttp().getResponse() as any;
      expect(res._headers['WWW-Authenticate']).toContain('invalid_request');
      expect(jwksService.verifyToken).not.toHaveBeenCalled();
    });

    it('@AcceptAuth("both") + API token → passes (unchanged behavior)', async () => {
      reflector.getAllAndOverride
        .mockReturnValueOnce(undefined) // IS_PUBLIC_KEY
        .mockReturnValueOnce('both')    // ACCEPT_AUTH_KEY
        .mockReturnValueOnce(undefined); // REQUIRED_PRIVILEGE_KEY
      jwksService.verifyApiToken.mockResolvedValue(mockApiTokenClaims);

      const ctx = makeContext({ headers: { 'x-api-key': 'valid.api.token' } });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('@AcceptAuth("jwt") + user JWT → 200', async () => {
      reflector.getAllAndOverride
        .mockReturnValueOnce(undefined) // IS_PUBLIC_KEY
        .mockReturnValueOnce('jwt')     // ACCEPT_AUTH_KEY
        .mockReturnValueOnce(undefined) // REQUIRED_ROLE_KEY
        .mockReturnValueOnce(undefined); // REQUIRED_FEATURE_FLAG_KEY
      jwksService.verifyToken.mockResolvedValue(mockClaims as any);

      const ctx = makeContext({ headers: { authorization: 'Bearer user.jwt.token' } });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(jwksService.verifyToken).toHaveBeenCalled();
    });
  });
});
