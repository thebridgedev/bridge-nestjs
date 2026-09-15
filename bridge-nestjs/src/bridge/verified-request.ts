// TBP-673 — the user token `BridgeAuthGuard` verified for a request.
//
// The guard records the token and its verified claims here, and
// `BridgeService.fromRequest(req)` reads them back, so a handler behind the
// guard gets a TenantScope without verifying the token a second time.
//
// A module-private WeakMap rather than a property on the request: only the
// guard can register an entry, so nothing else on the request — a header, a
// property another middleware set — can pass for a verified token. Entries go
// away with the request. Deliberately not exported from the package entry.

import type { JwtClaims } from '../types/user';

export interface VerifiedUserToken {
  token: string;
  claims: JwtClaims;
}

const verifiedUserTokens = new WeakMap<object, VerifiedUserToken>();

/** Called by `BridgeAuthGuard` right after it verified `token`. */
export function rememberVerifiedUserToken(req: object, token: string, claims: JwtClaims): void {
  verifiedUserTokens.set(req, { token, claims });
}

export function verifiedUserTokenFor(req: unknown): VerifiedUserToken | undefined {
  return req !== null && typeof req === 'object' ? verifiedUserTokens.get(req) : undefined;
}
