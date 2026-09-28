// bridge-nestjs/flags — `BridgeFlagGuard` (TBP-200).
//
// Reads `@RequireFlag('feature_x')` metadata from the handler/class, looks
// up the flag value via BridgeFlagsService, and throws ForbiddenException when
// the flag is off.
//
// The guard does NOT verify identity. Compose it with `BridgeAuthGuard` (or
// your own auth) so `req.bridgeUser` / `req.user` is populated before this
// runs — that verified identity is what gets bucketed for rolled-out rules.
// The eval context is built here, from verified sources only
// (`request-context.ts`); nothing a client sends — the `x-bridge-context`
// header, or anything copied from it onto the request — can change the
// decision (TBP-671).
//
// TBP-757 — the context carries the verified user's role, privileges and
// workspace plan, and (with `BridgeModule` loaded) the workspace's
// `bridge:billing.*` plan and entitlements, so a rule on any of those gives
// the same answer here as in the browser with no wiring. That lookup is async,
// hence `canActivate` returns a promise.

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { REQUIRE_FLAG_KEY, type RequireFlagMetadata } from './flag.decorator';
import { BridgeFlagsService } from './flags.service';
import {
  BRIDGE_FLAG_ATTRIBUTE_SOURCE,
  BRIDGE_FLAGS_OPTIONS,
  type BridgeFlagsModuleOptions,
  type FlagAttributeSource,
} from './flags.tokens';
import { featureRefusal, readExplanation } from './feature-refusal';
import { rememberResolvedFlagContext, resolvedFlagContext } from './request-context';

@Injectable()
export class BridgeFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly flags: BridgeFlagsService,
    @Optional()
    @Inject(BRIDGE_FLAG_ATTRIBUTE_SOURCE)
    private readonly attributeSource?: FlagAttributeSource,
    @Optional()
    @Inject(BRIDGE_FLAGS_OPTIONS)
    private readonly options?: BridgeFlagsModuleOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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
    const evalContext = await resolvedFlagContext(req, this.attributeSource);
    rememberResolvedFlagContext(req, evalContext);
    const result = this.flags.evaluate(meta.key, meta.defaultValue, evalContext);
    const value = result.value;

    const expected = meta.options.equals === undefined ? true : meta.options.equals;
    const passes = isEqual(value, expected) || (!!value && expected === true);

    if (passes) return true;

    if (meta.options.optional) {
      // Optional → skip silently. Useful for kill switches.
      return false;
    }

    // TBP-756 — 402 when an upgrade alone would turn it on, 403 otherwise,
    // naming the flag and the fix.
    throw featureRefusal(meta.key, readExplanation(result), this.options?.manageRoute);
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
