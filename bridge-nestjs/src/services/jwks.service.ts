import { Injectable } from '@nestjs/common';
import {
  JwksService as CoreJwksService,
  TokenVerificationError,
} from '@nebulr-group/bridge-auth-core/backend';
import type { ApiTokenClaims } from '@nebulr-group/bridge-auth-core/backend';
import { BridgeConfigService } from './bridge-config.service';
import { JwtClaims } from '../types/user';

/**
 * NestJS wrapper around auth-core's framework-agnostic token verifier.
 *
 * TBP-411 — this used to carry its own jose/JWKS implementation for both token
 * kinds. That worked for user tokens but could never work for API tokens: the
 * Bridge signs those HS256 with a per-app secret, so there is no public key to
 * fetch, and the endpoint it pointed at published the symmetric secret as an
 * `oct` JWK behind auth. API tokens are now verified by calling the Bridge's
 * introspection endpoint instead — no keys on the developer's side, and
 * revocation takes effect within the cache TTL (0 by default, i.e. instantly).
 *
 * The verification logic itself lives in auth-core so bridge-nestjs,
 * bridge-nextjs and any future backend plugin share one implementation. This
 * class only adapts NestJS DI onto it; the public surface — `verifyToken`,
 * `verifyApiToken`, `TokenVerificationError`, `ApiTokenClaims` — is unchanged,
 * so call sites and consumers need no edits.
 */
@Injectable()
export class JwksService {
  private core: CoreJwksService | null = null;

  constructor(private readonly configService: BridgeConfigService) {}

  /**
   * Built lazily rather than in the constructor: `BridgeConfigService` getters
   * derive URLs from config that must be fully resolved first, and a NestJS
   * provider is instantiated before we can guarantee that.
   */
  private get service(): CoreJwksService {
    if (!this.core) {
      this.core = new CoreJwksService({
        jwksUrl: this.configService.jwksUrl,
        introspectionUrl: this.configService.introspectionUrl,
        issuer: this.configService.authBaseUrl,
        audience: this.configService.appId,
        introspectionCacheTtlMs: this.configService.introspectionCacheTtlMs,
        log: (message: string, ...args: unknown[]) => this.configService.log(message, ...args),
      });
    }
    return this.core;
  }

  /**
   * Verify a user JWT (PS256, verified against the Bridge JWKS) and return its
   * claims.
   *
   * @throws TokenVerificationError if the token is invalid or expired
   */
  async verifyToken(token: string): Promise<JwtClaims> {
    return this.service.verifyToken(token) as Promise<JwtClaims>;
  }

  /**
   * Verify a Bridge API token via introspection and return its claims.
   *
   * Rejects tokens that are inactive (revoked or expired), not of type `api`,
   * or issued for a different app than `expectedAppId`.
   *
   * @throws TokenVerificationError with code `APP_MISMATCH` on wrong-app tokens
   */
  async verifyApiToken(token: string, expectedAppId: string): Promise<ApiTokenClaims> {
    return this.service.verifyApiToken(token, expectedAppId);
  }
}

export { TokenVerificationError };
export type { ApiTokenClaims };
