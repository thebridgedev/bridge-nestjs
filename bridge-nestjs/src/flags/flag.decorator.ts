// bridge-nestjs/flags — decorators (TBP-200).
//
// `@RequireFlag('flag_name')`  → applied to a controller method, makes the
//                                BridgeFlagGuard reject the request when the
//                                flag is off. Compose with the guard for it
//                                to take effect.
//
// `@Flag('flag_name', default)` → param decorator that reads the flag value
//                                 from BridgeFlags for the current request
//                                 (honors the per-request context populated
//                                 by BridgeContextInterceptor).

import {
  SetMetadata,
  createParamDecorator,
  type CustomDecorator,
  type ExecutionContext,
} from '@nestjs/common';

/** Metadata key for the `@RequireFlag` decorator — consumed by `BridgeFlagGuard`. */
export const REQUIRE_FLAG_KEY = 'bridge:flag:require';

export interface RequireFlagOptions {
  /**
   * Value to compare against for non-boolean flags. Defaults to `true`,
   * which works for the common boolean case (only enabled values pass).
   */
  equals?: unknown;
  /**
   * When true, skip the guard for this method instead of rejecting. Useful
   * for "kill switches" that disable a route without 403'ing.
   */
  optional?: boolean;
}

export interface RequireFlagMetadata {
  key: string;
  defaultValue: unknown;
  options: RequireFlagOptions;
}

/**
 * Method/class decorator. When applied alongside `BridgeFlagGuard`, the
 * decorated handler is gated on the flag being "on" (or equal to
 * `options.equals` for non-boolean flags).
 *
 *   @UseGuards(BridgeFlagGuard)
 *   @Controller('beta')
 *   class BetaController {
 *     @Get('feature-x')
 *     @RequireFlag('feature_x')
 *     getFeatureX() { ... }
 *   }
 */
export function RequireFlag(
  key: string,
  defaultValue: unknown = false,
  options: RequireFlagOptions = {},
): CustomDecorator<string> {
  const meta: RequireFlagMetadata = { key, defaultValue, options };
  return SetMetadata(REQUIRE_FLAG_KEY, meta);
}

/**
 * Param decorator — pulls a flag value into a handler argument.
 *
 *   @Get('home')
 *   home(@Flag('show_new_home', false) showNew: boolean) { ... }
 *
 * Reads from `request.bridgeFlagsContext` (set by `BridgeContextInterceptor`)
 * + the global BridgeFlags instance stored at `request.app.get('BRIDGE_FLAGS')`
 * via a tiny indirection through the request — see the interceptor.
 */
export const Flag = createParamDecorator(
  (data: { key: string; defaultValue: unknown }, ctx: ExecutionContext) => {
    const req: any = ctx.switchToHttp().getRequest();
    // req.bridgeFlags is the raw auth-core BridgeFlags instance (set by
    // BridgeContextInterceptor), which since 0.4.0-beta.10 returns
    // FlagEvalResult<T> = { passed, value } from .flag(). Extract .value
    // so @Flag(...) handler params still receive T as documented.
    const bridge = req?.bridgeFlags as
      | { flag: (k: string, def: unknown, ctx?: unknown) => { passed: boolean; value: unknown } }
      | undefined;
    if (!bridge) {
      return data?.defaultValue;
    }
    const perRequestCtx = req?.bridgeFlagsContext as unknown;
    return bridge.flag(data.key, data.defaultValue, perRequestCtx as any).value;
  },
);

/**
 * Helper for typed param decorators — TS doesn't preserve the generic on
 * `createParamDecorator`, so consumers wrap it.
 *
 *   const showNew = useFlagParam<boolean>('show_new_home', false);
 *   @Get('home')
 *   home(@showNew() show: boolean) { ... }
 *
 * Most apps just call `@Flag({ key, defaultValue })` inline.
 */
export function useFlagParam<T>(key: string, defaultValue: T) {
  return () => Flag({ key, defaultValue }) as unknown as ParameterDecorator;
}
