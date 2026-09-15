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

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

import { BridgeFlagsService } from './flags.service';
import { verifiedFlagContext } from './request-context';

@Injectable()
export class BridgeContextInterceptor implements NestInterceptor {
  constructor(private readonly flags: BridgeFlagsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req: any = context.switchToHttp().getRequest();
    if (req) {
      // Surface the bridge for `@Flag(...)` param decorators.
      req.bridgeFlags = this.flags.bridge;
      req.bridgeFlagsContext = verifiedFlagContext(req);
    }
    return next.handle();
  }
}
