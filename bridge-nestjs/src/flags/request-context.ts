// bridge-nestjs/flags — the per-request eval context, from verified sources only (TBP-671, TBP-757).
//
// Identity for flag evaluation comes from what the server itself verified:
// `req.bridgeUser` (set by `BridgeAuthGuard` from a signature-checked JWT),
// falling back to `req.user` (set by your own server-side auth).
//
// Targeting attributes are filled in with no wiring, under the same names the
// browser SDKs use (auth-core is the single source of the mapping):
//   - `user.id`, `user.role`, `user.email`, `tenant.id`, `tenant.plan`,
//     `privileges` — `claimsToAttributes` over the claims of the token
//     `BridgeAuthGuard` verified on this request, and
//   - `bridge:billing.plan`, `.subscription.status`, `.trial`,
//     `.entitlement.<key>` — `flattenBillingSnapshot` over the workspace's
//     `/session/init` snapshot (see `BridgeService.billingAttributesFor`),
//     cached per workspace. Only the async `resolvedFlagContext` adds these.
//     `bridge:billing.quota.*` is not available on the server yet:
//     `/session/init` does not carry quotas.
//
// Nothing here reads the request headers or a request property a client or a
// middleware could set. The `x-bridge-context` header is NOT trusted: any
// client can send one, and before TBP-671 its identity and attributes took
// precedence over the verified user. `req.user.role` from your own auth is not
// used for attributes either — only the token Bridge's guard verified is.
// A request with no verified user is evaluated anonymously.

import { Logger } from '@nestjs/common';
import {
  claimsToAttributes,
  type AuthJwtClaims,
  type EvalContext,
} from '@nebulr-group/bridge-auth-core';

import { verifiedUserTokenFor } from '../bridge/verified-request';
import type { FlagAttributeSource } from './flags.tokens';

/**
 * The synchronous context: verified identity plus the attributes in the
 * verified token's claims. Undefined when nobody verified is on the request.
 */
export function verifiedFlagContext(req: unknown): EvalContext | undefined {
  const r = req as { bridgeUser?: { id?: unknown }; user?: { id?: unknown } } | undefined;
  const identity = nonEmptyString(r?.bridgeUser?.id) ?? nonEmptyString(r?.user?.id);
  if (!identity) return undefined;
  const verified = verifiedUserTokenFor(req);
  return {
    identity,
    attributes: verified ? claimsToAttributes(verified.claims as AuthJwtClaims) : {},
  };
}

const logger = new Logger('BridgeFlags');
const warnedSources = new WeakSet<object>();

/**
 * The full context: {@link verifiedFlagContext} plus the workspace's
 * `bridge:billing.*` attributes from `source` (normally `BridgeService`).
 *
 * Billing attributes are fetched only for a user token `BridgeAuthGuard`
 * verified. When Bridge cannot be reached the context degrades to the claims
 * alone and the failure is logged once per source.
 */
export async function resolvedFlagContext(
  req: unknown,
  source?: FlagAttributeSource | null,
): Promise<EvalContext | undefined> {
  const base = verifiedFlagContext(req);
  if (!base || !source || !verifiedUserTokenFor(req)) return base;
  try {
    const billing = await source.billingAttributesFor(req);
    return { identity: base.identity, attributes: { ...base.attributes, ...billing } };
  } catch (err) {
    if (!warnedSources.has(source)) {
      warnedSources.add(source);
      logger.warn(
        `Could not read the workspace's plan and entitlements from Bridge; flag rules on bridge:billing.* see no value until it answers. ${(err as Error)?.message ?? String(err)}`,
      );
    }
    return base;
  }
}

// The context the guard / interceptor resolved for a request, for `@Flag(...)`
// (a synchronous param decorator). A module-private WeakMap rather than a
// request property: a property can be set by a middleware copying client
// input, an entry here only by this SDK.
const resolvedContexts = new WeakMap<object, EvalContext | undefined>();

export function rememberResolvedFlagContext(req: unknown, ctx: EvalContext | undefined): void {
  if (req !== null && typeof req === 'object') resolvedContexts.set(req, ctx);
}

/** The resolved context for `req` if the guard or interceptor made one, else the synchronous one. */
export function flagContextFor(req: unknown): EvalContext | undefined {
  if (req !== null && typeof req === 'object' && resolvedContexts.has(req)) {
    return resolvedContexts.get(req);
  }
  return verifiedFlagContext(req);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
