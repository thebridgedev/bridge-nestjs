import 'reflect-metadata';

// jose is ESM-only; mock it so CJS jest can load the module graph
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn().mockResolvedValue({ payload: {} }),
  errors: {
    JWTExpired: class extends Error {},
    JWTInvalid: class extends Error {},
    JWKSNoMatchingKey: class extends Error {},
    JWTClaimValidationFailed: class extends Error {},
  },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { BridgeModule } from './bridge.module';
import { BridgeConfigService } from './services/bridge-config.service';
import { JwksService } from './services/jwks.service';
import { FeatureFlagService } from './services/feature-flag.service';
import { BridgeHttpService } from './services/bridge-http.service';
import { BridgeAuthGuard } from './guards/bridge-auth.guard';

describe('BridgeModule', () => {
  describe('forRoot()', () => {
    let module: TestingModule;

    beforeEach(async () => {
      module = await Test.createTestingModule({
        imports: [
          BridgeModule.forRoot({
            appId: 'test-app',
            guard: { global: false },
          }),
        ],
      }).compile();
    });

    afterEach(async () => {
      await module.close();
    });

    it('should register BridgeConfigService', () => {
      const service = module.get(BridgeConfigService);
      expect(service).toBeInstanceOf(BridgeConfigService);
    });

    it('should register JwksService', () => {
      const service = module.get(JwksService);
      expect(service).toBeInstanceOf(JwksService);
    });

    it('should register FeatureFlagService', () => {
      const service = module.get(FeatureFlagService);
      expect(service).toBeInstanceOf(FeatureFlagService);
    });

    it('should register BridgeHttpService', () => {
      const service = module.get(BridgeHttpService);
      expect(service).toBeInstanceOf(BridgeHttpService);
    });

    it('should register BridgeAuthGuard', () => {
      const guard = module.get(BridgeAuthGuard);
      expect(guard).toBeInstanceOf(BridgeAuthGuard);
    });
  });

  describe('forRoot() with global guard', () => {
    let module: TestingModule;

    beforeEach(async () => {
      module = await Test.createTestingModule({
        imports: [
          BridgeModule.forRoot({
            appId: 'test-app',
            guard: { global: true },
          }),
        ],
      }).compile();
    });

    afterEach(async () => {
      await module.close();
    });

    it('should configure isGlobalGuard as true when guard.global is true', () => {
      // APP_GUARD is a multi-provider; verify through the config service instead
      const configService = module.get(BridgeConfigService);
      expect(configService.isGlobalGuard).toBe(true);
    });
  });

  describe('forRootAsync()', () => {
    let module: TestingModule;

    beforeEach(async () => {
      module = await Test.createTestingModule({
        imports: [
          BridgeModule.forRootAsync({
            useFactory: () => ({
              appId: 'async-app',
              guard: { global: false },
            }),
          }),
        ],
      }).compile();
    });

    afterEach(async () => {
      await module.close();
    });

    it('should register BridgeConfigService via factory', () => {
      const service = module.get(BridgeConfigService);
      expect(service).toBeInstanceOf(BridgeConfigService);
      expect(service.appId).toBe('async-app');
    });

    it('should register BridgeHttpService', () => {
      const service = module.get(BridgeHttpService);
      expect(service).toBeInstanceOf(BridgeHttpService);
    });
  });
});
