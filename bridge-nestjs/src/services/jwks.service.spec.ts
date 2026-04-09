import 'reflect-metadata';
import { JwksService, TokenVerificationError } from './jwks.service';
import { BridgeConfigService } from './bridge-config.service';

// Mock jose (ESM-only package — must be fully mocked for Jest/CJS compatibility)
jest.mock('jose', () => {
  class JWTExpired extends Error {
    constructor(message: string, payload?: any, claim?: string, reason?: string) {
      super(message);
      this.name = 'JWTExpired';
    }
  }
  class JWTInvalid extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'JWTInvalid';
    }
  }
  class JWKSNoMatchingKey extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'JWKSNoMatchingKey';
    }
  }
  class JWTClaimValidationFailed extends Error {
    constructor(message: string, payload?: any, claim?: string, reason?: string) {
      super(message);
      this.name = 'JWTClaimValidationFailed';
    }
  }
  return {
    createRemoteJWKSet: jest.fn(),
    jwtVerify: jest.fn(),
    errors: { JWTExpired, JWTInvalid, JWKSNoMatchingKey, JWTClaimValidationFailed },
  };
});

import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';

const mockConfigService = {
  jwksUrl: 'https://auth.example.com/.well-known/jwks.json',
  apiTokenJwksUrl: 'https://auth.example.com/account/app/.well-known/jwks.json',
  authBaseUrl: 'https://auth.example.com',
  appId: 'test-app',
  log: jest.fn(),
} as unknown as BridgeConfigService;

const mockJwks = jest.fn();

describe('JwksService', () => {
  let service: JwksService;

  beforeEach(() => {
    jest.clearAllMocks();
    (createRemoteJWKSet as jest.Mock).mockReturnValue(mockJwks);
    service = new JwksService(mockConfigService);
  });

  describe('verifyToken', () => {
    it('should return JWT claims on successful verification', async () => {
      const claims = { sub: 'user-1', email: 'test@example.com', tid: 'tenant-1' };
      (jwtVerify as jest.Mock).mockResolvedValue({ payload: claims });

      const result = await service.verifyToken('valid.token');
      expect(result).toEqual(claims);
    });

    it('should throw TokenVerificationError with TOKEN_EXPIRED for expired tokens', async () => {
      const expiredError = new joseErrors.JWTExpired('token expired');
      (jwtVerify as jest.Mock).mockRejectedValue(expiredError);

      await expect(service.verifyToken('expired.token')).rejects.toMatchObject({
        code: 'TOKEN_EXPIRED',
      });
    });

    it('should throw TokenVerificationError with TOKEN_INVALID for invalid tokens', async () => {
      const invalidError = new joseErrors.JWTInvalid('token invalid');
      (jwtVerify as jest.Mock).mockRejectedValue(invalidError);

      await expect(service.verifyToken('invalid.token')).rejects.toMatchObject({
        code: 'TOKEN_INVALID',
      });
    });

    it('should throw TokenVerificationError with JWKS_NO_MATCH when no matching key', async () => {
      const noKeyError = new joseErrors.JWKSNoMatchingKey();
      (jwtVerify as jest.Mock).mockRejectedValue(noKeyError);

      await expect(service.verifyToken('token')).rejects.toMatchObject({
        code: 'JWKS_NO_MATCH',
      });
    });

    it('should throw TokenVerificationError with CLAIM_VALIDATION_FAILED for claim errors', async () => {
      const claimError = new joseErrors.JWTClaimValidationFailed('claim failed', 'iss', 'check_failed');
      (jwtVerify as jest.Mock).mockRejectedValue(claimError);

      await expect(service.verifyToken('token')).rejects.toMatchObject({
        code: 'CLAIM_VALIDATION_FAILED',
      });
    });
  });

  describe('JWKS caching', () => {
    it('should only call createRemoteJWKSet once within TTL', async () => {
      (jwtVerify as jest.Mock).mockResolvedValue({ payload: { sub: 'user-1' } });

      await service.verifyToken('token1');
      await service.verifyToken('token2');

      expect(createRemoteJWKSet).toHaveBeenCalledTimes(1);
    });
  });

  describe('verifyApiToken', () => {
    it('should use apiTokenJwksUrl, not the user JWKS URL', async () => {
      const claims = {
        sub: 'token-1',
        appId: 'test-app',
        tenantId: null,
        type: 'api',
        privileges: ['USER_READ'],
      };
      (jwtVerify as jest.Mock).mockResolvedValue({ payload: claims });

      await service.verifyApiToken('api.token.here', 'test-app');

      // The second createRemoteJWKSet call should use the apiTokenJwksUrl
      expect(createRemoteJWKSet).toHaveBeenCalledWith(
        new URL('https://auth.example.com/account/app/.well-known/jwks.json'),
      );
    });

    it('should throw APP_MISMATCH when payload.appId !== expectedAppId', async () => {
      (jwtVerify as jest.Mock).mockResolvedValue({
        payload: {
          sub: 'token-1',
          appId: 'other-app',
          tenantId: null,
          type: 'api',
          privileges: [],
        },
      });

      await expect(service.verifyApiToken('api.token.here', 'test-app')).rejects.toMatchObject({
        code: 'APP_MISMATCH',
      });
    });

    it('API token JWKS client is cached independently from the user JWKS client', async () => {
      const claims = {
        sub: 'token-1',
        appId: 'test-app',
        tenantId: null,
        type: 'api',
        privileges: [],
      };
      (jwtVerify as jest.Mock).mockResolvedValue({ payload: { sub: 'user-1' } });
      await service.verifyToken('user.token');

      (jwtVerify as jest.Mock).mockResolvedValue({ payload: claims });
      await service.verifyApiToken('api.token.here', 'test-app');
      await service.verifyApiToken('api.token2.here', 'test-app');

      // User JWKS: 1 call (user JWKS URL), API token JWKS: 1 call (api token JWKS URL)
      // Total: 2 calls to createRemoteJWKSet
      expect(createRemoteJWKSet).toHaveBeenCalledTimes(2);
      expect(createRemoteJWKSet).toHaveBeenNthCalledWith(
        1,
        new URL('https://auth.example.com/.well-known/jwks.json'),
      );
      expect(createRemoteJWKSet).toHaveBeenNthCalledWith(
        2,
        new URL('https://auth.example.com/account/app/.well-known/jwks.json'),
      );
    });
  });
});
