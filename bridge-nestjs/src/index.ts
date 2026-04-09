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

// Services
export { BridgeConfigService, BRIDGE_CONFIG } from './services/bridge-config.service';
export { JwksService, TokenVerificationError } from './services/jwks.service';
export type { ApiTokenClaims } from './services/jwks.service';
export { FeatureFlagService } from './services/feature-flag.service';
export { BridgeHttpService, BridgeHttpError } from './services/bridge-http.service';

// Types
export type {
  BridgeConfig,
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

