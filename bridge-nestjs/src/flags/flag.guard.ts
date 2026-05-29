// bridge-nestjs/flags — `BridgeFlagGuard` (TBP-200).
//
// Reads `@RequireFlag('feature_x')` metadata from the handler/class, looks
// up the flag value via BridgeFlagsService (honoring the per-request eval
// context populated by `BridgeContextInterceptor`), and throws
// ForbiddenException when the flag is off.
//
// The guard does NOT verify identity. Compose it with `BridgeAuthGuard` (or
// your own auth) so `req.user` / `req.bridgeUser` is populated before this
// runs — that identity is what gets bucketed for rolled-out rules.

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { REQUIRE_FLAG_KEY, type RequireFlagMetadata } from './flag.decorator';
import { BridgeFlagsService } from './flags.service';

@Injectable()
export class BridgeFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly flags: BridgeFlagsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const meta = this.reflector.getAllAndOverride<RequireFlagMetadata>(REQUIRE_FLAG_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!meta) return true; // no `@RequireFlag` — pass

    const req: any = context.switchToHttp().getRequest();
    // Surface the bridge instance on the request so `@Flag(...)` param
    // decorators can reach it without re-injecting BridgeFlagsService.
    if (req) {
      req.bridgeFlags = this.flags.bridge;
    }
    const perRequestCtx = req?.bridgeFlagsContext;

    const value = this.flags.flag(meta.key, meta.defaultValue, perRequestCtx);

    const expected = meta.options.equals === undefined ? true : meta.options.equals;
    const passes = isEqual(value, expected) || (!!value && expected === true);

    if (passes) return true;

    if (meta.options.optional) {
      // Optional → skip silently. Useful for kill switches.
      return false;
    }

    throw new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      message: `Feature flag '${meta.key}' is not enabled`,
    });
  }
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}
