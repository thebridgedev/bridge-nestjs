/**
 * Backend auth types are now owned by @nebulr-group/bridge-auth-core/backend.
 *
 * This module re-exports them so existing imports
 * (`import { BridgeUser, JwtClaims, transformJwtToBridgeUser } from '../types/user'`)
 * keep working unchanged. The shapes — including the `privileges` field — are
 * identical to what bridge-nestjs defined locally before the extraction.
 */
export type { BridgeUser, JwtClaims } from '@nebulr-group/bridge-auth-core/backend';
export { transformJwtToBridgeUser } from '@nebulr-group/bridge-auth-core/backend';
