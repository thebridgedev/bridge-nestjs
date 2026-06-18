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
  introspectionUrl: 'https://auth.example.com/account/api-token/introspect',
  introspectionCacheTtlMs: 0,
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

  describe('verifyApiToken (introspection)', () => {
    // API tokens are now verified by POSTing to the Bridge introspection
    // endpoint (global fetch), NOT via JWKS. Mock global fetch for these.
    let fetchMock: jest.Mock;

    beforeEach(() => {
      fetchMock = jest.fn();
      (global as any).fetch = fetchMock;
    });

    const introspectionResponse = (body: unknown, ok = true, status = 200) =>
      ({ ok, status, json: async () => body }) as unknown as Response;

    it('POSTs the token to the introspection URL and returns claims', async () => {
      fetchMock.mockResolvedValue(
        introspectionResponse({
          active: true,
          sub: 'token-1',
          appId: 'test-app',
          tenantId: null,
          type: 'api',
          privileges: ['USER_READ'],
        }),
      );

      const claims = await service.verifyApiToken('api.token.here', 'test-app');

      expect(claims).toMatchObject({ appId: 'test-app', privileges: ['USER_READ'] });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://auth.example.com/account/api-token/introspect');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ token: 'api.token.here' });
    });

    it('throws TOKEN_INVALID when introspection reports inactive', async () => {
      fetchMock.mockResolvedValue(introspectionResponse({ active: false }));

      await expect(service.verifyApiToken('dead.token', 'test-app')).rejects.toMatchObject({
        code: 'TOKEN_INVALID',
      });
    });

    it('throws APP_MISMATCH when the token belongs to a different app', async () => {
      fetchMock.mockResolvedValue(
        introspectionResponse({
          active: true,
          sub: 'token-1',
          appId: 'other-app',
          tenantId: null,
          type: 'api',
          privileges: [],
        }),
      );

      await expect(service.verifyApiToken('api.token.here', 'test-app')).rejects.toMatchObject({
        code: 'APP_MISMATCH',
      });
    });

    it('throws UNKNOWN_ERROR when the introspection request fails', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.verifyApiToken('api.token.here', 'test-app')).rejects.toMatchObject({
        code: 'UNKNOWN_ERROR',
      });
    });

    it('does NOT touch the user JWKS path (createRemoteJWKSet not called)', async () => {
      fetchMock.mockResolvedValue(
        introspectionResponse({
          active: true,
          sub: 'token-1',
          appId: 'test-app',
          tenantId: null,
          type: 'api',
          privileges: [],
        }),
      );

      await service.verifyApiToken('api.token.here', 'test-app');
      expect(createRemoteJWKSet).not.toHaveBeenCalled();
    });
  });
});
