import { SetMetadata } from '@nestjs/common';
import type { FeatureFlagRequirement } from '../options';

export const REQUIRED_FEATURE_FLAG_KEY = 'bridge:requiredFeatureFlag';

/**
 * Lets the call through only when the flag is on for the caller. Every gate is
 * a flag: the flag's rule in Bridge says why (a privilege, a plan feature, a
 * rollout), so the code never reads a role, a privilege or the plan.
 *
 * Refuses with `402 FEATURE_NOT_IN_PLAN` when a plan feature is what keeps the
 * flag off (an upgrade would turn it on), else `403 FEATURE_OFF`.
 *
 * @example
 *   @RequireFlag('reports')
 *   @RequireFlag({ any: ['reports', 'reports-beta'] })
 */
export const RequireFlag = (requirement: FeatureFlagRequirement) => SetMetadata(REQUIRED_FEATURE_FLAG_KEY, requirement);

/** The same as `RequireFlag`, under its 0.x name. */
export const RequireFeatureFlag = RequireFlag;
