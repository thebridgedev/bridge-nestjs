import { DynamicModule, Global, Logger, Module, Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { createBridgeServer, type BridgeServer, type BridgeServerOptions } from '@nebulr-group/bridge-auth-core/server';
import { BridgeService } from './bridge.service';
import { BridgeAuthGuard } from './guards/bridge-auth.guard';
import { BridgeManagementService } from './management/management.service';
import { BridgeQuotaInterceptor } from './quota/quota.interceptor';
import { BridgeQuotaService } from './quota/quota.service';
import { BRIDGE_DEFAULTS, BRIDGE_OPTIONS, BRIDGE_SERVER, type BridgeModuleAsyncOptions, type BridgeModuleOptions } from './options';
import { BridgeMeterInterceptor } from './usage/meter';
import { BridgeWebhookGuard } from './webhooks/webhook.guard';

const EXPORTS = [BRIDGE_OPTIONS, BRIDGE_SERVER, BridgeService, BridgeAuthGuard, BridgeManagementService, BridgeMeterInterceptor, BridgeQuotaService, BridgeQuotaInterceptor, BridgeWebhookGuard];

/**
 * Settings not given are read from the environment: `BRIDGE_ISSUER`,
 * `BRIDGE_APP_KEY` and `BRIDGE_WEBHOOK_SECRETS` (comma-separated).
 */
export function resolveBridgeOptions(options: Partial<BridgeModuleOptions> = {}, env: Record<string, string | undefined> = process.env): BridgeModuleOptions {
  const secrets = (env['BRIDGE_WEBHOOK_SECRETS'] ?? '').split(',').map((secret) => secret.trim()).filter(Boolean);
  return {
    ...options,
    issuer: options.issuer || env['BRIDGE_ISSUER'] || '',
    ...(options.appKey === undefined && env['BRIDGE_APP_KEY'] ? { appKey: env['BRIDGE_APP_KEY'] } : {}),
    ...(options.webhookSecrets === undefined && secrets.length > 0 ? { webhookSecrets: secrets } : {}),
  };
}

/**
 * What the module hands auth-core. The revocation limits are always set here
 * (reads 5 minutes, writes 90 seconds, as Bridge's own Access Layer), so the
 * plugin's promise does not move with auth-core's own defaults.
 */
export function serverOptionsFor(options: BridgeModuleOptions, logger: Pick<Logger, 'debug'> = new Logger('Bridge')): BridgeServerOptions {
  if (typeof options.issuer !== 'string' || options.issuer === '') {
    throw new Error('BridgeModule needs the issuer: pass `issuer`, or set BRIDGE_ISSUER. It is the app\'s issuer, as the browser SDK takes it.');
  }
  return {
    issuer: options.issuer,
    ...(options.appKey ? { appKey: options.appKey } : {}),
    ...(options.audience ? { audience: options.audience } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    maxLagMs: options.maxLagMs ?? BRIDGE_DEFAULTS.maxLagMs,
    strictLagMs: options.strictLagMs ?? BRIDGE_DEFAULTS.strictLagMs,
    ...(options.revocationIntervalMs === undefined ? {} : { revocationIntervalMs: options.revocationIntervalMs }),
    ...(options.usageFlushMs === undefined ? {} : { usageFlushMs: options.usageFlushMs }),
    ...(options.usageStore === undefined ? {} : { usageStore: options.usageStore }),
    ...(options.maxQueuedReports === undefined ? {} : { maxQueuedReports: options.maxQueuedReports }),
    ...(options.maxQueuedAgeMs === undefined ? {} : { maxQueuedAgeMs: options.maxQueuedAgeMs }),
    log: (message, details) => (options.debug ? logger.debug(details === undefined ? message : `${message} ${JSON.stringify(details)}`) : undefined),
  };
}

function serverFor(options: BridgeModuleOptions): BridgeServer {
  return createBridgeServer(serverOptionsFor(options));
}

/**
 * The Bridge in a NestJS app: token checks that follow the app's revocation
 * list, flag gates, "count this", the management client and webhook checks.
 *
 * @example
 *   BridgeModule.forRoot()        // BRIDGE_ISSUER, BRIDGE_APP_KEY, BRIDGE_WEBHOOK_SECRETS
 *   BridgeModule.forRoot({
 *     issuer: process.env.BRIDGE_ISSUER!,
 *     appKey: process.env.BRIDGE_APP_KEY,
 *     guard: { global: true },
 *   })
 */
@Global()
@Module({})
export class BridgeModule {
  static forRoot(given: Partial<BridgeModuleOptions> = {}): DynamicModule {
    const options = resolveBridgeOptions(given);
    const providers: Provider[] = [
      { provide: BRIDGE_OPTIONS, useValue: options },
      { provide: BRIDGE_SERVER, useFactory: serverFor, inject: [BRIDGE_OPTIONS] },
      ...this.common(),
    ];
    if (options.guard?.global) providers.push({ provide: APP_GUARD, useExisting: BridgeAuthGuard });
    return { module: BridgeModule, providers, exports: EXPORTS };
  }

  static forRootAsync(async: BridgeModuleAsyncOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: BRIDGE_OPTIONS,
        useFactory: async (...args: unknown[]) => resolveBridgeOptions(await async.useFactory(...args)),
        inject: async.inject ?? [],
      },
      { provide: BRIDGE_SERVER, useFactory: serverFor, inject: [BRIDGE_OPTIONS] },
      ...this.common(),
      {
        provide: APP_GUARD,
        useFactory: (options: BridgeModuleOptions, guard: BridgeAuthGuard) => (options.guard?.global ? guard : { canActivate: () => true }),
        inject: [BRIDGE_OPTIONS, BridgeAuthGuard],
      },
    ];
    return { module: BridgeModule, imports: async.imports ?? [], providers, exports: EXPORTS };
  }

  private static common(): Provider[] {
    return [BridgeService, BridgeAuthGuard, BridgeManagementService, BridgeMeterInterceptor, BridgeQuotaService, BridgeQuotaInterceptor, BridgeWebhookGuard];
  }
}
