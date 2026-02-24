import { SetMetadata } from '@nestjs/common';
import { FeatureFlagRequirement } from '../types/config';

export const REQUIRED_FEATURE_FLAG_KEY = 'bridge:requiredFeatureFlag';

/**
 * Decorator to require a feature flag (or flags) for a route or controller.
 * This decorator overrides any feature flag requirement from route rules configuration.
 * 
 * @param flag - The required feature flag(s)
 *   - string: Single flag name
 *   - { any: string[] }: At least one of the flags must be enabled
 *   - { all: string[] }: All flags must be enabled
 * 
 * @example
 * ```typescript
 * @Get('beta-feature')
 * @RequireFeatureFlag('beta-access')
 * getBetaFeature() { ... }
 * 
 * @Get('premium')
 * @RequireFeatureFlag({ all: ['premium-tier', 'active-subscription'] })
 * getPremiumFeature() { ... }
 * 
 * @Get('experimental')
 * @RequireFeatureFlag({ any: ['beta-tester', 'internal-user'] })
 * getExperimentalFeature() { ... }
 * ```
 */
export const RequireFeatureFlag = (flag: FeatureFlagRequirement) =>
  SetMetadata(REQUIRED_FEATURE_FLAG_KEY, flag);

