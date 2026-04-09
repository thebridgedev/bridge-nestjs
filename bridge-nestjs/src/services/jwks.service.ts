import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, JWTPayload } from 'jose';
import { BridgeConfigService } from './bridge-config.service';
import { JwtClaims } from '../types/user';

/**
 * Claims present in a Bridge API token JWT.
 */
export interface ApiTokenClaims extends JWTPayload {
  sub: string;
  appId: string;
  tenantId: string | null;
  type: 'api';
  privileges: string[];
}

/**
 * Service for JWKS-based JWT verification
 */
@Injectable()
export class JwksService {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private jwksInitTime: number = 0;

  private apiTokenJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private apiTokenJwksInitTime: number = 0;

  private readonly JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

  constructor(private readonly configService: BridgeConfigService) {}

  /**
   * Initialize or refresh the user-token JWKS client
   */
  private ensureJwks(): ReturnType<typeof createRemoteJWKSet> {
    const now = Date.now();

    if (!this.jwks || now - this.jwksInitTime > this.JWKS_CACHE_TTL_MS) {
      this.configService.log('Initializing JWKS client', { url: this.configService.jwksUrl });
      this.jwks = createRemoteJWKSet(new URL(this.configService.jwksUrl));
      this.jwksInitTime = now;
    }

    return this.jwks;
  }

  /**
   * Initialize or refresh the API token JWKS client (cached independently).
   */
  private ensureApiTokenJwks(): ReturnType<typeof createRemoteJWKSet> {
    const now = Date.now();

    if (!this.apiTokenJwks || now - this.apiTokenJwksInitTime > this.JWKS_CACHE_TTL_MS) {
      this.configService.log('Initializing API token JWKS client', {
        url: this.configService.apiTokenJwksUrl,
      });
      this.apiTokenJwks = createRemoteJWKSet(new URL(this.configService.apiTokenJwksUrl));
      this.apiTokenJwksInitTime = now;
    }

    return this.apiTokenJwks;
  }

  /**
   * Verify a user JWT token and return the claims.
   *
   * @param token - The JWT token to verify
   * @returns The verified JWT claims
   * @throws TokenVerificationError if token is invalid
   */
  async verifyToken(token: string): Promise<JwtClaims> {
    const jwks = this.ensureJwks();

    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: this.configService.authBaseUrl,
        audience: this.configService.appId,
      });

      this.configService.log('Token verified successfully', {
        sub: payload.sub,
        iss: payload.iss,
        aud: payload.aud,
      });

      return payload as JwtClaims;
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) {
        this.configService.log('Token verification failed: Token expired');
        throw new TokenVerificationError('Token expired', 'TOKEN_EXPIRED');
      }
      if (error instanceof joseErrors.JWTInvalid) {
        this.configService.log('Token verification failed: Invalid token');
        throw new TokenVerificationError('Invalid token', 'TOKEN_INVALID');
      }
      if (error instanceof joseErrors.JWKSNoMatchingKey) {
        this.configService.log('Token verification failed: No matching key in JWKS');
        throw new TokenVerificationError('Invalid token signature', 'JWKS_NO_MATCH');
      }
      if (error instanceof joseErrors.JWTClaimValidationFailed) {
        this.configService.log('Token verification failed: Claim validation failed', error.message);
        throw new TokenVerificationError('Token claim validation failed', 'CLAIM_VALIDATION_FAILED');
      }

      this.configService.log('Token verification failed: Unknown error', error);
      throw new TokenVerificationError('Token verification failed', 'UNKNOWN_ERROR');
    }
  }

  /**
   * Verify a Bridge API token JWT and return the claims.
   *
   * Uses a separate JWKS client (cached independently from the user-token client).
   *
   * @param token - The JWT API token to verify
   * @param expectedAppId - The app ID the token should be issued for
   * @returns The verified API token claims
   * @throws TokenVerificationError if token is invalid, expired, wrong type, or wrong app
   */
  async verifyApiToken(token: string, expectedAppId: string): Promise<ApiTokenClaims> {
    const jwks = this.ensureApiTokenJwks();

    try {
      const { payload } = await jwtVerify(token, jwks);

      if (payload['type'] !== 'api') {
        throw new TokenVerificationError('Wrong token type', 'TOKEN_INVALID');
      }

      if (payload['appId'] !== expectedAppId) {
        throw new TokenVerificationError('Token issued for a different app', 'APP_MISMATCH');
      }

      this.configService.log('API token verified successfully', {
        sub: payload.sub,
        appId: payload['appId'],
      });

      return payload as ApiTokenClaims;
    } catch (error) {
      if (error instanceof TokenVerificationError) {
        throw error;
      }
      if (error instanceof joseErrors.JWTExpired) {
        this.configService.log('API token verification failed: Token expired');
        throw new TokenVerificationError('Token expired', 'TOKEN_EXPIRED');
      }
      if (error instanceof joseErrors.JWTInvalid) {
        this.configService.log('API token verification failed: Invalid token');
        throw new TokenVerificationError('Invalid token', 'TOKEN_INVALID');
      }
      if (error instanceof joseErrors.JWKSNoMatchingKey) {
        this.configService.log('API token verification failed: No matching key in JWKS');
        throw new TokenVerificationError('Invalid token signature', 'JWKS_NO_MATCH');
      }
      if (error instanceof joseErrors.JWTClaimValidationFailed) {
        this.configService.log(
          'API token verification failed: Claim validation failed',
          error.message,
        );
        throw new TokenVerificationError('Token claim validation failed', 'CLAIM_VALIDATION_FAILED');
      }

      this.configService.log('API token verification failed: Unknown error', error);
      throw new TokenVerificationError('Token verification failed', 'UNKNOWN_ERROR');
    }
  }
}

/**
 * Error class for token verification failures
 */
export class TokenVerificationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}
