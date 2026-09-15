// bridge-nestjs/flags — the per-request eval context, from verified sources only (TBP-671).
//
// Identity for flag evaluation comes from what the server itself verified:
// `req.bridgeUser` (set by `BridgeAuthGuard` from a signature-checked JWT),
// falling back to `req.user` (set by your own server-side auth). Targeting
// attributes such as `tenant.plan` or `user.role` come from attribute
// providers registered on the flags instance, which read verified claims.
//
// Nothing here reads the request headers. In particular the `x-bridge-context`
// header is NOT trusted: any client can send one, and before TBP-671 its
// identity and attributes took precedence over the verified user — a request
// carrying `tenant.plan: enterprise` and somebody else's `sub` was evaluated as
// that user on that plan. A request with no verified user is evaluated
// anonymously.

import type { EvalContext } from '@nebulr-group/bridge-auth-core';

export function verifiedFlagContext(req: unknown): EvalContext | undefined {
  const r = req as { bridgeUser?: { id?: unknown }; user?: { id?: unknown } } | undefined;
  const identity = nonEmptyString(r?.bridgeUser?.id) ?? nonEmptyString(r?.user?.id);
  return identity ? { identity, attributes: {} } : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
