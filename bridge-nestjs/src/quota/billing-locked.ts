// A workspace locked for payment, answered with 0.9's 402 body.
//
// Bridge refuses a write in a locked workspace with the problem
// `urn:bridge:problem:billing-locked`. The app's client gets the same body it
// got from 0.9, `code: 'BILLING_GATE_ENGAGED'`, wherever the refusal comes
// from: the guard checking the caller, or a hold for a plan limit. The
// problem's own fields (`type`, `title`, `status`, `detail`) are kept beside it.

import { HttpException, HttpStatus } from '@nestjs/common';
import { isBridgeError } from '@nebulr-group/bridge-auth-core/server';

/** Where a workspace locked for payment is sent to pay, unless Bridge says another. */
const LOCK_FIX = '/subscription';

/** Body of the 402 a workspace locked for payment is refused with. */
export interface BillingLockedBody {
  statusCode: 402;
  code: 'BILLING_GATE_ENGAGED';
  message: string;
  reason: 'billing_locked';
  /** `access` is Bridge's access state for the workspace, when it says it (`blocked`). */
  billing: { status: string; gateEngaged: true; recoveryUrl: string; access?: string };
  /** Where to manage the plan: the module's `manageRoute`, default `/subscription`. */
  fix: string;
  /** Bridge's problem, when it sent one: `urn:bridge:problem:billing-locked`. */
  type?: string;
  title?: string;
  status?: 402;
  detail?: string;
}

/** 402 for a workspace locked for payment: it can be read, not changed, until it pays. */
export class BillingLockedException extends HttpException {
  constructor(public readonly body: BillingLockedBody) {
    super(body, HttpStatus.PAYMENT_REQUIRED);
  }
}

/** A refusal because the workspace is locked for payment, as 0.9's 402; null for any other failure. */
export function billingLockedFrom(error: unknown, fix: string): BillingLockedException | null {
  if (!isBridgeError(error) || error.status !== 402) return null;
  const problem = (error.problem ?? null) as (Record<string, unknown> & { billing?: { status?: unknown; recoveryUrl?: unknown; access?: unknown } }) | null;
  const locked =
    error.code === 'BILLING_GATE_ENGAGED' ||
    error.code === 'billing-locked' ||
    problem?.['type'] === 'urn:bridge:problem:billing-locked' ||
    problem?.['reason'] === 'billing_locked';
  if (!locked) return null;
  const billing = problem?.billing ?? (error as { payload?: { billing?: { status?: unknown; recoveryUrl?: unknown; access?: unknown } } }).payload?.billing;
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
  return new BillingLockedException({
    ...(text(problem?.['type']) === undefined ? {} : { type: text(problem?.['type']) }),
    ...(text(problem?.['title']) === undefined ? {} : { title: text(problem?.['title']) }),
    ...(problem === null ? {} : { status: 402 as const }),
    ...(text(problem?.['detail']) === undefined ? {} : { detail: text(problem?.['detail']) }),
    statusCode: 402,
    code: 'BILLING_GATE_ENGAGED',
    message: 'Billing gate engaged — workspace access is locked',
    reason: 'billing_locked',
    billing: {
      status: text(billing?.status) ?? 'past_due',
      gateEngaged: true,
      recoveryUrl: text(billing?.recoveryUrl) ?? LOCK_FIX,
      ...(text(billing?.access) === undefined ? {} : { access: text(billing?.access) }),
    },
    fix,
  });
}
