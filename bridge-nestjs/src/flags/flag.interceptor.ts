// bridge-nestjs/flags — `BridgeContextInterceptor` (TBP-200).
//
// Pulls the propagated eval context out of the `x-bridge-context` header
// (set by the frontend SDK via auth-core's `serializeContext`) and stashes
// it on the request as `request.bridgeFlagsContext`. The guard + param
// decorator read it from there so flag evals match what the frontend just
// computed for the same user.
//
// When the header is missing or malformed, the interceptor is a no-op —
// the request still works, it just falls back to the module's global
// context for evals.

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import {
  BRIDGE_CONTEXT_HEADER,
  deserializeContext,
} from '@nebulr-group/bridge-auth-core';
import type { Observable } from 'rxjs';

import { BridgeFlagsService } from './flags.service';

@Injectable()
export class BridgeContextInterceptor implements NestInterceptor {
  constructor(private readonly flags: BridgeFlagsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req: any = context.switchToHttp().getRequest();
    if (req) {
      // Surface the bridge for `@Flag(...)` param decorators.
      req.bridgeFlags = this.flags.bridge;

      const headerValue = readHeader(req, BRIDGE_CONTEXT_HEADER);
      const propagated = headerValue ? deserializeContext(headerValue) : undefined;

      // Merge identity / attributes from the propagated header with anything
      // an upstream guard already attached to `req.user` / `req.bridgeUser`.
      const identity =
        propagated?.identity ??
        (req?.bridgeUser?.id as string | undefined) ??
        (req?.user?.id as string | undefined);
      const attributes = {
        ...(propagated?.attributes ?? {}),
      };

      req.bridgeFlagsContext = identity || Object.keys(attributes).length > 0
        ? { identity, attributes }
        : undefined;
    }
    return next.handle();
  }
}

function readHeader(req: { headers?: Record<string, string | string[] | undefined> }, name: string): string | undefined {
  const raw = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}
