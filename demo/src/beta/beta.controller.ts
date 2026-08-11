import { Controller, Get } from '@nestjs/common';
import {
  RequireFeatureFlag,
  CurrentUser,
  BridgeUser,
  FeatureFlagService,
} from '@nebulr-group/bridge-nestjs';
import { Request } from 'express';
import { Req } from '@nestjs/common';

/**
 * Beta features controller - routes gated by feature flags.
 * The controller-level @RequireFeatureFlag('beta-access') applies to all routes;
 * individual routes override it with their own @RequireFeatureFlag(...).
 */
@Controller('beta')
@RequireFeatureFlag('beta-access')
export class BetaController {
  constructor(private readonly featureFlagService: FeatureFlagService) {}

  /**
   * Beta feature - requires 'beta-access' flag (from controller-level decorator)
   */
  @Get('feature')
  getBetaFeature(@CurrentUser() user: BridgeUser) {
    return {
      message: 'Welcome to the beta feature!',
      user: user.email,
      feature: {
        name: 'Beta Dashboard',
        version: '2.0-beta',
      },
    };
  }

  /**
   * Premium reports - requires both 'premium-tier' and 'active-subscription' flags.
   * Overrides the controller-level 'beta-access' requirement.
   */
  @Get('premium/reports')
  @RequireFeatureFlag({ all: ['premium-tier', 'active-subscription'] })
  getPremiumReports(@CurrentUser() user: BridgeUser) {
    return {
      message: 'Premium reports',
      user: user.email,
      reports: [
        { id: 1, name: 'Revenue Report', type: 'premium' },
        { id: 2, name: 'User Analytics', type: 'premium' },
      ],
    };
  }

  /**
   * Experimental feature - uses decorator to override config
   * Requires ANY of 'beta-tester' OR 'internal-user' flag
   */
  @Get('experimental')
  @RequireFeatureFlag({ any: ['beta-tester', 'internal-user'] })
  getExperimentalFeature(@CurrentUser() user: BridgeUser) {
    return {
      message: 'Experimental feature access granted',
      user: user.email,
      experiment: {
        name: 'New UI',
        enabled: true,
      },
    };
  }

  /**
   * Check feature flags programmatically
   */
  @Get('check-flags')
  async checkFlags(@CurrentUser() user: BridgeUser, @Req() req: Request) {
    const accessToken = req.bridgeAccessToken!;

    const [betaAccess, premiumTier, betaTester] = await Promise.all([
      this.featureFlagService.isEnabled('beta-access', accessToken),
      this.featureFlagService.isEnabled('premium-tier', accessToken),
      this.featureFlagService.isEnabled('beta-tester', accessToken),
    ]);

    return {
      user: user.email,
      flags: {
        'beta-access': betaAccess,
        'premium-tier': premiumTier,
        'beta-tester': betaTester,
      },
    };
  }
}

