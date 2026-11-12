import { SetMetadata } from '@nestjs/common';

export const STRICT_KEY = 'bridge:strict';

/**
 * Checks this route against a revocation list at most `strictLagMs` behind
 * (30 seconds by default), as writes are. Use it on a sensitive read; pass
 * `false` to relax a write that may tolerate the normal lag.
 */
export const Strict = (strict = true) => SetMetadata(STRICT_KEY, strict);
