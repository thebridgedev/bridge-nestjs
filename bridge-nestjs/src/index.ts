// The module and its options.
export { BridgeModule, resolveBridgeOptions } from './bridge.module';
export {
  BRIDGE_OPTIONS,
  BRIDGE_SERVER,
  BRIDGE_DEFAULTS,
  type BridgeModuleOptions,
  type BridgeModuleAsyncOptions,
  type GuardConfig,
  type RouteRule,
  type RoutePrivilege,
  type FeatureFlagRequirement,
} from './options';

// Checking who calls.
export { BridgeService } from './bridge.service';
export { BridgeAuthGuard } from './guards/bridge-auth.guard';
export { bridgeStateOf, type BridgeRequestState } from './request-context';

// Decorators.
export * from './decorators';

// Flag gates and why they refuse.
export * from './flags';

// "Count this".
export * from './usage';

// The management client.
export * from './management';

// Webhooks.
export * from './webhooks';

// From auth-core, so an app needs no direct dependency on it.
export { BridgeError, isBridgeError, FlagSet, createBridgeServer } from '@nebulr-group/bridge-auth-core/server';
export type { Actor, BridgeErrorKind, BridgeServer, FlagReason, FlagResult, Hint, VerifyOptions } from '@nebulr-group/bridge-auth-core/server';
