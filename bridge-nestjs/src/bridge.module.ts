import { DynamicModule, Global, Module, Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { BridgePullCache } from '@nebulr-group/bridge-auth-core';
import { BridgeAuthGuard } from './guards/bridge-auth.guard';
import { BRIDGE_CONFIG, BridgeConfigService } from './services/bridge-config.service';
import { FeatureFlagService } from './services/feature-flag.service';
import { JwksService } from './services/jwks.service';
import { BridgeHttpService } from './services/bridge-http.service';
import { BridgeConfig, BridgeModuleAsyncOptions, BridgeModuleConfig } from './types/config';
// TBP-704 — plan limits and entitlements as decorators.
import { BridgeQuotaService } from './quota/quota.service';
import { BridgeQuotaInterceptor } from './quota/quota.interceptor';
// TBP-341 — unified backend bridge surface.
import { BRIDGE_FLAG_ATTRIBUTE_SOURCE, BRIDGE_PULL_CACHE } from './flags/flags.tokens';
import { BridgeService } from './bridge/bridge.service';
import { BRIDGE_OPTIONS } from './bridge/bridge.tokens';

/**
 * Bridge module for NestJS applications.
 * 
 * Provides authentication, role-based access control, and feature flag support.
 * 
 * @example
 * ```typescript
 * // Zero config: appId / apiBaseUrl / debug come from BRIDGE_APP_ID,
 * // BRIDGE_API_BASE_URL and BRIDGE_DEBUG.
 * @Module({ imports: [BridgeModule.forRoot()] })
 * export class AppModule {}
 *
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
 * // With global guard and route rules.
 * // Central rules express privilege/plan only. Role gating uses @RequireRole
 * // and feature-flag gating uses @RequireFeatureFlag on the controller/route.
 * @Module({
 *   imports: [
 *     BridgeModule.forRoot({
 *       appId: 'your-app-id',
 *       guard: {
 *         global: true,
 *         defaultAccess: 'protected',
 *         rules: [
 *           { path: '/health', privilege: 'ANONYMOUS' },
 *           { path: '/account/users', privilege: 'USER_READ' },
 *           { path: '/reports/*', privilege: 'TENANT_READ', plans: ['pro', 'enterprise'] },
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
   * Configure the Bridge module with static configuration.
   *
   * TBP-704 — every field is optional. `appId`, `apiBaseUrl` and `debug`
   * fall back to `BRIDGE_APP_ID`, `BRIDGE_API_BASE_URL` and `BRIDGE_DEBUG`
   * (`'true'` turns it on); a value passed here always wins. Throws when no
   * app id is found either way, rather than starting up unable to verify a
   * single token.
   */
  static forRoot(config: BridgeModuleConfig = {}): DynamicModule {
    const providers = this.createProviders(resolveBridgeConfig(config));
    
    return {
      module: BridgeModule,
      providers,
      exports: [
        BridgeConfigService,
        JwksService,
        FeatureFlagService,
        BridgeAuthGuard,
        BridgeHttpService,
        BridgeService,
        BRIDGE_FLAG_ATTRIBUTE_SOURCE,
        BRIDGE_PULL_CACHE,
        BridgeQuotaService,
        BridgeQuotaInterceptor,
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
        BridgeService,
        BRIDGE_FLAG_ATTRIBUTE_SOURCE,
        BRIDGE_PULL_CACHE,
        BridgeQuotaService,
        BridgeQuotaInterceptor,
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
      // TBP-341 — unified backend bridge surface.
      {
        provide: BRIDGE_OPTIONS,
        useValue: {
          apiBaseUrl: config.apiBaseUrl ?? 'https://api.thebridge.dev',
          appId: config.appId,
          ttlMs: 30_000,
        },
      },
      {
        provide: BRIDGE_PULL_CACHE,
        useFactory: () => new BridgePullCache({ ttlMs: 30_000 }),
      },
      BridgeService,
      // TBP-757 — flag rules see the workspace's plan and entitlements.
      { provide: BRIDGE_FLAG_ATTRIBUTE_SOURCE, useExisting: BridgeService },
      BridgeQuotaService,
      BridgeQuotaInterceptor,
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

    // TBP-341 — unified backend bridge surface (async path).
    const bridgeOptionsProvider: Provider = {
      provide: BRIDGE_OPTIONS,
      useFactory: (configService: BridgeConfigService) => ({
        apiBaseUrl: configService.apiBaseUrl,
        appId: configService.appId,
        ttlMs: 30_000,
      }),
      inject: [BridgeConfigService],
    };
    const pullCacheProvider: Provider = {
      provide: BRIDGE_PULL_CACHE,
      useFactory: () => new BridgePullCache({ ttlMs: 30_000 }),
    };

    return [
      configProvider,
      BridgeConfigService,
      JwksService,
      FeatureFlagService,
      BridgeAuthGuard,
      BridgeHttpService,
      globalGuardProvider,
      bridgeOptionsProvider,
      pullCacheProvider,
      BridgeService,
      // TBP-757 — flag rules see the workspace's plan and entitlements.
      { provide: BRIDGE_FLAG_ATTRIBUTE_SOURCE, useExisting: BridgeService },
      BridgeQuotaService,
      BridgeQuotaInterceptor,
    ];
  }
}


/**
 * TBP-704 — fill `appId` / `apiBaseUrl` / `debug` from the environment where
 * the caller left them out. Explicit values win, including an explicit
 * `debug: false` over `BRIDGE_DEBUG=true`.
 */
export function resolveBridgeConfig(
  config: BridgeModuleConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
  const appId = config.appId || env.BRIDGE_APP_ID;
  if (!appId) {
    throw new Error(
      '[bridge-nestjs] BridgeModule.forRoot() needs an app id: pass `appId` or set BRIDGE_APP_ID.',
    );
  }
  return {
    ...config,
    appId,
    apiBaseUrl: config.apiBaseUrl || env.BRIDGE_API_BASE_URL || undefined,
    debug: config.debug ?? env.BRIDGE_DEBUG === 'true',
  };
}
