// Module
export { BridgeModule } from './bridge.module';

// Guards
export { BridgeAuthGuard } from './guards/bridge-auth.guard';

// Decorators
export { CurrentUser } from './decorators/current-user.decorator';
export { CurrentTenant } from './decorators/current-tenant.decorator';
export { Public, IS_PUBLIC_KEY } from './decorators/public.decorator';
export { RequireRole, REQUIRED_ROLE_KEY } from './decorators/require-role.decorator';
export { RequireFeatureFlag, REQUIRED_FEATURE_FLAG_KEY } from './decorators/require-feature-flag.decorator';
export { RequirePrivilege, REQUIRED_PRIVILEGE_KEY } from './decorators/require-privilege.decorator';
export { AcceptAuth, ACCEPT_AUTH_KEY, type AuthType } from './decorators/accept-auth.decorator';

// TBP-704 — plan limits and entitlements as decorators, and as plain service calls.
export {
  RequireQuota,
  SyncQuota,
  RequireEntitlement,
  REQUIRED_QUOTA_KEY,
  SYNC_QUOTA_KEY,
  REQUIRED_ENTITLEMENT_KEY,
  BridgeQuotaInterceptor,
  USAGE_COUNTED_HEADER,
  BridgeQuotaService,
  QuotaExceededException,
  EntitlementRequiredException,
  type QuotaTenant,
  type QuotaCounter,
  type RequireQuotaOptions,
  type SyncQuotaOptions,
  type QuotaExceededBody,
  type EntitlementRequiredBody,
  type QuotaCount,
  type QuotaCheckOptions,
  type QuotaDecision,
  type QuotaRecordOptions,
} from './quota';

// Services
export { BridgeConfigService, BRIDGE_CONFIG } from './services/bridge-config.service';
export { JwksService, TokenVerificationError } from './services/jwks.service';
export type { ApiTokenClaims } from './services/jwks.service';
export { FeatureFlagService, type RequirementVerdict } from './services/feature-flag.service';
// TBP-756 — why a flag-gated endpoint refused (402 FEATURE_NOT_IN_PLAN,
// 403 FEATURE_NOT_PERMITTED, 403 FEATURE_OFF).
export {
  FeatureNotInPlanException,
  FeatureForbiddenException,
  featureRefusalBody,
  type FeatureRefusalBody,
  type FeatureRefusalCode,
  type FeatureOffReason,
} from './flags/feature-refusal';
export { BridgeHttpService, BridgeHttpError } from './services/bridge-http.service';

// TBP-341 — Unified backend bridge surface (`bridge.fromJwt(jwt)` → TenantScope).
export {
  BridgeService,
  TenantScope,
  BRIDGE_OPTIONS,
  type BridgeModuleOptions,
  type BrandingSnapshot,
  type QuotaSnapshot,
  type SessionSnapshotData,
  type SubscriptionSnapshot,
  type TenantEntitlementsView,
  type TenantUsageView,
  type UserSnapshot,
} from './bridge';

// Types
export type {
  BridgeConfig,
  BridgeModuleConfig,
  BillingConfig,
  BridgeModuleAsyncOptions,
  GuardConfig,
  RouteRule,
  FeatureFlagRequirement,
} from './types/config';
export { BRIDGE_DEFAULTS } from './types/config';

export type { BridgeUser, JwtClaims } from './types/user';
export { transformJwtToBridgeUser } from './types/user';

export type { BridgeTenant } from './types/tenant';
export { transformJwtToBridgeTenant } from './types/tenant';

