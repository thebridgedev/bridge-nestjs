import 'reflect-metadata';

// jose is ESM-only; mock it so CJS jest can load auth-core's backend module graph
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

// TBP-411 — verification itself now lives in auth-core. This spec covers the
// NestJS wrapper only, so auth-core's `JwksService` class is replaced with a
// constructor spy while everything else (notably the real
// `TokenVerificationError`) stays actual. Mocking the class rather than
// `fetch`/`jose` keeps these tests on the wrapper's seam instead of
// re-testing auth-core.
jest.mock('@nebulr-group/bridge-auth-core/backend', () => {
  const actual = jest.requireActual('@nebulr-group/bridge-auth-core/backend');
  return {
    ...actual,
    JwksService: jest.fn(),
  };
});

import {
  JwksService as CoreJwksService,
  type JwksServiceConfig,
} from '@nebulr-group/bridge-auth-core/backend';
import { JwksService, TokenVerificationError } from './jwks.service';
import { BridgeConfigService } from './bridge-config.service';
import type { BridgeConfig } from '../types/config';

const CoreJwksServiceMock = CoreJwksService as unknown as jest.Mock;

const mockUserClaims = {
  sub: 'user-1',
  email: 'test@example.com',
  tid: 'tenant-1',
  role: 'USER',
};

const mockApiTokenClaims = {
  sub: 'token-1',
  appId: 'test-app',
  tenantId: null,
  type: 'api' as const,
  privileges: ['USER_READ'],
};

let coreVerifyToken: jest.Mock;
let coreVerifyApiToken: jest.Mock;

function makeService(overrides: Partial<BridgeConfig> = {}): {
  service: JwksService;
  configService: BridgeConfigService;
} {
  const configService = new BridgeConfigService({
    appId: 'test-app',
    apiBaseUrl: 'https://api.example.com',
    ...overrides,
  } as BridgeConfig);
  return { service: new JwksService(configService), configService };
}

/** Config object the wrapper handed to auth-core on the Nth construction. */
function coreConfig(callIndex = 0): JwksServiceConfig {
  return CoreJwksServiceMock.mock.calls[callIndex][0] as JwksServiceConfig;
}

describe('JwksService (NestJS wrapper around auth-core)', () => {
  beforeEach(() => {
    coreVerifyToken = jest.fn();
    coreVerifyApiToken = jest.fn();
    CoreJwksServiceMock.mockReset();
    CoreJwksServiceMock.mockImplementation(() => ({
      verifyToken: coreVerifyToken,
      verifyApiToken: coreVerifyApiToken,
    }));
  });

  describe('verifyToken', () => {
    it('should delegate to auth-core and return its claims', async () => {
      coreVerifyToken.mockResolvedValue(mockUserClaims);
      const { service } = makeService();

      const result = await service.verifyToken('valid.user.token');

      expect(result).toEqual(mockUserClaims);
      expect(coreVerifyToken).toHaveBeenCalledTimes(1);
      expect(coreVerifyToken).toHaveBeenCalledWith('valid.user.token');
    });

    it.each([
      ['TOKEN_EXPIRED', 'Token expired'],
      ['TOKEN_INVALID', 'Invalid token'],
      ['JWKS_NO_MATCH', 'Invalid token signature'],
      ['CLAIM_VALIDATION_FAILED', 'Token claim validation failed'],
      ['UNKNOWN_ERROR', 'Token verification failed'],
    ])('should propagate a %s TokenVerificationError unchanged', async (code, message) => {
      const coreError = new TokenVerificationError(message, code);
      coreVerifyToken.mockRejectedValue(coreError);
      const { service } = makeService();

      // Identity check: the wrapper must not wrap, re-map or re-message it.
      await expect(service.verifyToken('bad.token')).rejects.toBe(coreError);
      await expect(service.verifyToken('bad.token')).rejects.toBeInstanceOf(
        TokenVerificationError,
      );
      await expect(service.verifyToken('bad.token')).rejects.toMatchObject({ code, message });
    });
  });

  describe('verifyApiToken', () => {
    it('should delegate to auth-core with the expected appId and return ApiTokenClaims', async () => {
      coreVerifyApiToken.mockResolvedValue(mockApiTokenClaims);
      const { service } = makeService();

      const result = await service.verifyApiToken('api.token.here', 'test-app');

      expect(result).toEqual(mockApiTokenClaims);
      expect(coreVerifyApiToken).toHaveBeenCalledTimes(1);
      expect(coreVerifyApiToken).toHaveBeenCalledWith('api.token.here', 'test-app');
    });

    it.each([
      ['TOKEN_INVALID', 'Invalid token'],
      ['APP_MISMATCH', 'Token issued for a different app'],
      ['UNKNOWN_ERROR', 'Introspection request failed'],
    ])('should propagate a %s TokenVerificationError unchanged', async (code, message) => {
      const coreError = new TokenVerificationError(message, code);
      coreVerifyApiToken.mockRejectedValue(coreError);
      const { service } = makeService();

      await expect(service.verifyApiToken('api.token.here', 'test-app')).rejects.toBe(coreError);
      await expect(
        service.verifyApiToken('api.token.here', 'test-app'),
      ).rejects.toBeInstanceOf(TokenVerificationError);
      await expect(service.verifyApiToken('api.token.here', 'test-app')).rejects.toMatchObject({
        code,
        message,
      });
    });
  });

  describe('core service construction', () => {
    it('should build the core service from BridgeConfigService values', async () => {
      coreVerifyToken.mockResolvedValue(mockUserClaims);
      const { service } = makeService();

      await service.verifyToken('token');

      expect(CoreJwksServiceMock).toHaveBeenCalledTimes(1);
      expect(coreConfig()).toEqual(
        expect.objectContaining({
          jwksUrl: 'https://api.example.com/auth/.well-known/jwks.json',
          introspectionUrl: 'https://api.example.com/account/api-token/introspect',
          issuer: 'https://api.example.com/auth',
          audience: 'test-app',
          introspectionCacheTtlMs: 0,
        }),
      );
    });

    it('should forward the BridgeConfigService logger', async () => {
      coreVerifyToken.mockResolvedValue(mockUserClaims);
      const { service } = makeService({ debug: true });
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});

      try {
        await service.verifyToken('token');
        coreConfig().log!('core message', { a: 1 });
        expect(spy).toHaveBeenCalledWith('[Bridge] core message', { a: 1 });
      } finally {
        spy.mockRestore();
      }
    });

    it('should not construct the core service until the first verification', () => {
      makeService();
      expect(CoreJwksServiceMock).not.toHaveBeenCalled();
    });

    it('should construct the core service once and reuse it across calls', async () => {
      coreVerifyToken.mockResolvedValue(mockUserClaims);
      coreVerifyApiToken.mockResolvedValue(mockApiTokenClaims);
      const { service } = makeService();

      await service.verifyToken('token-1');
      await service.verifyToken('token-2');
      await service.verifyApiToken('api.token.here', 'test-app');

      expect(CoreJwksServiceMock).toHaveBeenCalledTimes(1);
      expect(coreVerifyToken).toHaveBeenCalledTimes(2);
      expect(coreVerifyApiToken).toHaveBeenCalledTimes(1);
    });

    it('should honour an explicit introspectionUrl override', async () => {
      coreVerifyApiToken.mockResolvedValue(mockApiTokenClaims);
      const { service } = makeService({
        introspectionUrl: 'http://host.docker.internal:3200/account/api-token/introspect',
      });

      await service.verifyApiToken('api.token.here', 'test-app');

      expect(coreConfig().introspectionUrl).toBe(
        'http://host.docker.internal:3200/account/api-token/introspect',
      );
    });

    it('should honour an explicit userJwksUrl override', async () => {
      coreVerifyToken.mockResolvedValue(mockUserClaims);
      const { service } = makeService({
        userJwksUrl: 'http://host.docker.internal:3200/auth/.well-known/jwks.json',
      });

      await service.verifyToken('token');

      expect(coreConfig().jwksUrl).toBe(
        'http://host.docker.internal:3200/auth/.well-known/jwks.json',
      );
    });

    it('should forward an explicit introspectionCacheTtlMs', async () => {
      coreVerifyApiToken.mockResolvedValue(mockApiTokenClaims);
      const { service } = makeService({ introspectionCacheTtlMs: 30_000 });

      await service.verifyApiToken('api.token.here', 'test-app');

      expect(coreConfig().introspectionCacheTtlMs).toBe(30_000);
    });

    it('should default introspectionCacheTtlMs to 0 so revocation is instant', async () => {
      coreVerifyApiToken.mockResolvedValue(mockApiTokenClaims);
      const { service } = makeService();

      await service.verifyApiToken('api.token.here', 'test-app');

      expect(coreConfig().introspectionCacheTtlMs).toBe(0);
    });

    it('should ignore the deprecated apiTokenJwksUrl config field', async () => {
      coreVerifyApiToken.mockResolvedValue(mockApiTokenClaims);
      const { service } = makeService({
        apiTokenJwksUrl: 'https://api.example.com/account/app/.well-known/jwks.json',
      });

      await service.verifyApiToken('api.token.here', 'test-app');

      expect(coreConfig().introspectionUrl).toBe(
        'https://api.example.com/account/api-token/introspect',
      );
      expect(JSON.stringify(coreConfig())).not.toContain('account/app/.well-known/jwks.json');
    });
  });

  describe('re-exports', () => {
    it('should re-export auth-core TokenVerificationError so consumer instanceof checks hold', () => {
      const actual = jest.requireActual('@nebulr-group/bridge-auth-core/backend');
      expect(TokenVerificationError).toBe(actual.TokenVerificationError);
    });
  });
});
