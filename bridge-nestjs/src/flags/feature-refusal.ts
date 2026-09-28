// bridge-nestjs/flags — a flag-gated endpoint that refuses says why (TBP-756).
//
// Both flag guards (`BridgeFlagGuard` for `@RequireFlag`, `BridgeAuthGuard` for
// `@RequireFeatureFlag` and route rules) refuse with one of three bodies:
//
//   402 FEATURE_NOT_IN_PLAN   — an upgrade alone would turn the feature on
//   403 FEATURE_NOT_PERMITTED — the person's role or privileges keep it off
//   403 FEATURE_OFF           — switched off, another condition, the rollout,
//                               or the reason is unknown
//
// Each names the flag and the fix. A 403 keeps the old `error` / `message`
// fields, so a client reading those sees what it always saw.
//
// Pure: no Nest DI and nothing from the auth half, so the auth-free `/flags`
// entry point can use it.

import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';

/** Why a feature is off — the same values auth-core's evaluator and bridge-api's evaluate return. */
export type FeatureOffReason = 'plan' | 'permission' | 'off' | 'rule' | 'rollout';

/** Why a flag is off, as the evaluator or Bridge's evaluate endpoint said. */
export interface FeatureOffExplanation {
  reason?: FeatureOffReason;
  /** With `plan`: the plan feature the flag's rule asks for. */
  feature?: string;
}

export type FeatureRefusalCode = 'FEATURE_NOT_IN_PLAN' | 'FEATURE_NOT_PERMITTED' | 'FEATURE_OFF';

/** Body of a flag refusal. */
export interface FeatureRefusalBody {
  statusCode: 402 | 403;
  code: FeatureRefusalCode;
  error: 'Payment Required' | 'Forbidden';
  message: string;
  /** The flag (or `{any}` / `{all}` requirement, as JSON) that refused. */
  flag: string;
  reason?: FeatureOffReason;
  /** With FEATURE_NOT_IN_PLAN: the plan feature the rule asks for, when it names one. */
  feature?: string;
  /**
   * What fixes it. FEATURE_NOT_IN_PLAN: the path to upgrade at
   * (`billing.manageRoute`, default `/subscription`). The others: a sentence.
   */
  fix: string;
}

export const DEFAULT_MANAGE_ROUTE = '/subscription';

const REASONS: ReadonlySet<string> = new Set(['plan', 'permission', 'off', 'rule', 'rollout']);

/** The explanation in an evaluate response or eval result, or `{}` when it carries none. */
export function readExplanation(source: unknown): FeatureOffExplanation {
  if (!source || typeof source !== 'object') return {};
  const s = source as { reason?: unknown; feature?: unknown };
  if (typeof s.reason !== 'string' || !REASONS.has(s.reason)) return {};
  return {
    reason: s.reason as FeatureOffReason,
    ...(typeof s.feature === 'string' && s.feature ? { feature: s.feature } : {}),
  };
}

/** The refusal body for a flag that is off. */
export function featureRefusalBody(
  flag: string,
  explanation: FeatureOffExplanation | undefined,
  manageRoute: string = DEFAULT_MANAGE_ROUTE,
): FeatureRefusalBody {
  const reason = explanation?.reason;
  if (reason === 'plan') {
    const what = explanation?.feature ?? flag;
    return {
      statusCode: 402,
      code: 'FEATURE_NOT_IN_PLAN',
      error: 'Payment Required',
      message: `Your plan does not include '${what}'. Upgrade to use it.`,
      flag,
      reason,
      ...(explanation?.feature ? { feature: explanation.feature } : {}),
      fix: manageRoute || DEFAULT_MANAGE_ROUTE,
    };
  }
  if (reason === 'permission') {
    return {
      statusCode: 403,
      code: 'FEATURE_NOT_PERMITTED',
      error: 'Forbidden',
      message: `Feature flag '${flag}' is not enabled for your role or privileges`,
      flag,
      reason,
      fix: 'Ask a workspace admin for access.',
    };
  }
  return {
    statusCode: 403,
    code: 'FEATURE_OFF',
    error: 'Forbidden',
    message: `Feature flag '${flag}' is not enabled`,
    flag,
    ...(reason ? { reason } : {}),
    fix:
      reason === 'off'
        ? 'This feature is switched off for everyone.'
        : 'This feature is not available to this user.',
  };
}

/**
 * 402 FEATURE_NOT_IN_PLAN. Nest has no built-in exception for 402.
 */
export class FeatureNotInPlanException extends HttpException {
  constructor(public readonly body: FeatureRefusalBody) {
    super(body, HttpStatus.PAYMENT_REQUIRED);
  }
}

/**
 * 403 FEATURE_NOT_PERMITTED / FEATURE_OFF. A `ForbiddenException`, as the flag
 * guards threw before TBP-756, so an app's exception filters keep matching.
 */
export class FeatureForbiddenException extends ForbiddenException {
  constructor(public readonly body: FeatureRefusalBody) {
    super(body);
  }
}

/** A flag refusal as an exception: 402 for a plan reason, a `ForbiddenException` otherwise. */
export function featureRefusal(
  flag: string,
  explanation: FeatureOffExplanation | undefined,
  manageRoute?: string,
): FeatureNotInPlanException | FeatureForbiddenException {
  const body = featureRefusalBody(flag, explanation, manageRoute);
  return body.statusCode === 402 ? new FeatureNotInPlanException(body) : new FeatureForbiddenException(body);
}
