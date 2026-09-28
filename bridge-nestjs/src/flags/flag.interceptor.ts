// bridge-nestjs/flags — `BridgeContextInterceptor` (TBP-200, TBP-671).
//
// Puts the per-request eval context on the request as
// `request.bridgeFlagsContext` (and the flags instance as
// `request.bridgeFlags`, for `@Flag(...)`), so handlers can pass it straight
// into `flags.flag(key, default, req.bridgeFlagsContext)`.
//
// The context is built ONLY from what the server verified — `req.bridgeUser`,
// then `req.user` (see `request-context.ts`). The `x-bridge-context` request
// header is internal and is never trusted: a client can put any identity or
// `tenant.plan` in it (TBP-671). With no verified user the context is
// undefined and evaluation is anonymous.
//
// TBP-757 — the context includes the verified user's role, privileges and
// plan, plus the workspace's `bridge:billing.*` attributes when `BridgeModule`
// is loaded (see `request-context.ts`). Resolving those is async; the handler
// runs once they are in.

import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { from, type Observable } from 'rxjs';
import { mergeMap } from 'rxjs/operators';

import { BridgeFlagsService } from './flags.service';
import { BRIDGE_FLAG_ATTRIBUTE_SOURCE, type FlagAttributeSource } from './flags.tokens';
import { rememberResolvedFlagContext, resolvedFlagContext } from './request-context';

@Injectable()
export class BridgeContextInterceptor implements NestInterceptor {
  constructor(
    private readonly flags: BridgeFlagsService,
    @Optional()
    @Inject(BRIDGE_FLAG_ATTRIBUTE_SOURCE)
    private readonly attributeSource?: FlagAttributeSource,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req: any = context.switchToHttp().getRequest();
    if (!req) return next.handle();
    // Surface the bridge for `@Flag(...)` param decorators.
    req.bridgeFlags = this.flags.bridge;
    return from(resolvedFlagContext(req, this.attributeSource)).pipe(
      mergeMap((evalContext) => {
        rememberResolvedFlagContext(req, evalContext);
        req.bridgeFlagsContext = evalContext;
        return next.handle();
      }),
    );
  }
}
