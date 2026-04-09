import { DynamicModule, Global, Module, Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { BridgeAuthGuard } from './guards/bridge-auth.guard';
import { BRIDGE_CONFIG, BridgeConfigService } from './services/bridge-config.service';
import { FeatureFlagService } from './services/feature-flag.service';
import { JwksService } from './services/jwks.service';
import { BridgeHttpService } from './services/bridge-http.service';
import { BridgeConfig, BridgeModuleAsyncOptions } from './types/config';

/**
 * Bridge module for NestJS applications.
 * 
 * Provides authentication, role-based access control, and feature flag support.
 * 
 * @example
 * ```typescript
 * // Basic usage
 * @Module({
 *   imports: [
 *     BridgeModule.forRoot({
 *       appId: 'your-app-id',
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * 
 * // With global guard and route rules
 * @Module({
 *   imports: [
 *     BridgeModule.forRoot({
 *       appId: 'your-app-id',
 *       guard: {
 *         global: true,
 *         defaultAccess: 'protected',
 *         rules: [
 *           { path: '/health', public: true },
 *           { path: '/admin/*', role: 'ADMIN' },
 *           { path: '/beta/*', featureFlag: 'beta-access' },
 *         ],
 *       },
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * 
 * // Async configuration
 * @Module({
 *   imports: [
 *     BridgeModule.forRootAsync({
 *       imports: [ConfigModule],
 *       inject: [ConfigService],
 *       useFactory: (config: ConfigService) => ({
 *         appId: config.get('BRIDGE_APP_ID'),
 *         debug: config.get('BRIDGE_DEBUG') === 'true',
 *       }),
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Global()
@Module({})
export class BridgeModule {
  /**
   * Configure the Bridge module with static configuration
   */
  static forRoot(config: BridgeConfig): DynamicModule {
    const providers = this.createProviders(config);
    
    return {
      module: BridgeModule,
      providers,
      exports: [
        BridgeConfigService,
        JwksService,
        FeatureFlagService,
        BridgeAuthGuard,
        BridgeHttpService,
      ],
    };
  }

  /**
   * Configure the Bridge module with async configuration
   */
  static forRootAsync(options: BridgeModuleAsyncOptions): DynamicModule {
    const providers = this.createAsyncProviders(options);

    return {
      module: BridgeModule,
      imports: options.imports || [],
      providers,
      exports: [
        BridgeConfigService,
        JwksService,
        FeatureFlagService,
        BridgeAuthGuard,
        BridgeHttpService,
      ],
    };
  }

  /**
   * Create providers for synchronous configuration
   */
  private static createProviders(config: BridgeConfig): Provider[] {
    const providers: Provider[] = [
      {
        provide: BRIDGE_CONFIG,
        useValue: config,
      },
      BridgeConfigService,
      JwksService,
      FeatureFlagService,
      BridgeAuthGuard,
      BridgeHttpService,
    ];

    // Add global guard if configured
    if (config.guard?.global) {
      providers.push({
        provide: APP_GUARD,
        useExisting: BridgeAuthGuard,
      });
    }

    return providers;
  }

  /**
   * Create providers for asynchronous configuration
   */
  private static createAsyncProviders(options: BridgeModuleAsyncOptions): Provider[] {
    const configProvider: Provider = {
      provide: BRIDGE_CONFIG,
      useFactory: options.useFactory,
      inject: options.inject || [],
    };

    // We need a separate provider to conditionally register the global guard
    // since we don't know the config until runtime
    const globalGuardProvider: Provider = {
      provide: APP_GUARD,
      useFactory: (configService: BridgeConfigService, guard: BridgeAuthGuard) => {
        if (configService.isGlobalGuard) {
          return guard;
        }
        // Return a pass-through guard if not global
        return { canActivate: () => true };
      },
      inject: [BridgeConfigService, BridgeAuthGuard],
    };

    return [
      configProvider,
      BridgeConfigService,
      JwksService,
      FeatureFlagService,
      BridgeAuthGuard,
      BridgeHttpService,
      globalGuardProvider,
    ];
  }
}

