// bridge-nestjs/flags — public barrel for the auth-free Feature Flags 2.0 entry point (TBP-200).
//
// Import from `@nebulr-group/bridge-nestjs/flags` — this path is intentionally
// auth-free so apps in standalone-FF mode don't pull in BridgeAuthGuard,
// JWKS, or the bridge HTTP client.

export { BridgeFlagsModule } from './flags.module';
export {
  BRIDGE_FLAGS,
  BRIDGE_FLAGS_OPTIONS,
  BRIDGE_PULL_CACHE,
  type BridgeFlagsModuleOptions,
} from './flags.tokens';
export { BridgeFlagsService } from './flags.service';
export {
  RequireFlag,
  Flag,
  useFlagParam,
  REQUIRE_FLAG_KEY,
  type RequireFlagOptions,
  type RequireFlagMetadata,
} from './flag.decorator';
export { BridgeFlagGuard } from './flag.guard';
export { BridgeContextInterceptor } from './flag.interceptor';

// Auth-core re-exports so consumers don't need a direct dep when they only
// want flag types.
export {
  BridgeFlags,
  BridgePullCache,
  attachIdentity,
  MemoryIdentityStorage,
  generateAnonymousId,
  BRIDGE_CONTEXT_HEADER,
  serializeContext,
  deserializeContext,
  serverInstanceId,
} from '@nebulr-group/bridge-auth-core';

export type {
  CachedFlag,
  FlagValueType,
  EvalTelemetry,
  DiscoveryTelemetry,
  BridgeFlagsHooks,
  DeclaredAttributeType,
  AttributeDeclaration,
  BridgeFlagsMode,
  BridgeRuntimeMode,
  PullCacheOptions,
  EvalContext,
  IdentityStorage,
  AnonymousTrackingMode,
  BridgeIdentity,
  RealtimeMessage,
  ConnectionState,
} from '@nebulr-group/bridge-auth-core';
