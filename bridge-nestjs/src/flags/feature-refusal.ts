import { HttpException, HttpStatus } from '@nestjs/common';
import type { FlagSet } from '@nebulr-group/bridge-auth-core/server';
import type { FeatureFlagRequirement } from '../options';

/**
 * Why a flag-gated endpoint refused:
 *
 *   402 FEATURE_NOT_IN_PLAN — a plan feature is what keeps the flag off: an upgrade would turn it on
 *   403 FEATURE_OFF         — anything else: the rule, a rollout, switched off, or Bridge could not answer
 */
export type FeatureRefusalCode = 'FEATURE_NOT_IN_PLAN' | 'FEATURE_OFF';

export interface FeatureRefusalBody {
  statusCode: 402 | 403;
  code: FeatureRefusalCode;
  error: 'Payment Required' | 'Forbidden';
  message: string;
  /** The flag that was off. */
  flag: string;
  /** The plan feature the flag's rule needs, for a 402. */
  feature?: string;
  /** Bridge's own words for which part of the rule decided, when it says. */
  why?: string;
  /** What the caller can do about it. */
  fix: string;
}

export const DEFAULT_MANAGE_ROUTE = '/subscription';

/** The refusal for a flag that is off, from the reason Bridge gave. */
export function featureRefusalBody(flags: FlagSet, flag: string, manageRoute: string = DEFAULT_MANAGE_ROUTE): FeatureRefusalBody {
  const reason = flags.reason(flag);
  if (reason.entitlement !== null) {
    return {
      statusCode: 402,
      code: 'FEATURE_NOT_IN_PLAN',
      error: 'Payment Required',
      message: `Your plan does not include '${reason.entitlement}'. Upgrade to use it.`,
      flag,
      feature: reason.entitlement,
      ...(reason.why === null ? {} : { why: reason.why }),
      fix: manageRoute || DEFAULT_MANAGE_ROUTE,
    };
  }
  return {
    statusCode: 403,
    code: 'FEATURE_OFF',
    error: 'Forbidden',
    message: `Feature flag '${flag}' is not enabled`,
    flag,
    ...(reason.why === null ? {} : { why: reason.why }),
    fix: 'This feature is not available to this caller.',
  };
}

export class FeatureNotInPlanException extends HttpException {
  constructor(public readonly body: FeatureRefusalBody) {
    super(body, HttpStatus.PAYMENT_REQUIRED);
  }
}

export class FeatureForbiddenException extends HttpException {
  constructor(public readonly body: FeatureRefusalBody) {
    super(body, HttpStatus.FORBIDDEN);
  }
}

/** The exception for a refusal body. */
export function featureRefusal(body: FeatureRefusalBody): HttpException {
  return body.statusCode === 402 ? new FeatureNotInPlanException(body) : new FeatureForbiddenException(body);
}

/**
 * The first flag that keeps a requirement from being met, or null when it is
 * met. For `any`, the first flag listed stands for the refusal; a 402 is
 * preferred when an upgrade would turn on any of them.
 */
export function unmetFlag(flags: FlagSet, requirement: FeatureFlagRequirement): string | null {
  if (typeof requirement === 'string') return flags.enabled(requirement) ? null : requirement;
  if ('all' in requirement) return requirement.all.find((key) => !flags.enabled(key)) ?? null;
  const keys = requirement.any;
  if (keys.some((key) => flags.enabled(key))) return null;
  return keys.find((key) => flags.reason(key).entitlement !== null) ?? keys[0] ?? '(no flag named)';
}
