import { ExecutionContext } from '@nestjs/common';

/**
 * Extracts the Express request from an ExecutionContext,
 * handling both HTTP and GraphQL contexts.
 *
 * Uses the same approach as BridgeAuthGuard.extractContext().
 */
export function getRequestFromContext(ctx: ExecutionContext): any {
  if (ctx.getType<string>() === 'graphql') {
    // GQL execution context args: [root, args, context, info]
    const gqlContext = ctx.getArgByIndex(2);
    return gqlContext?.req ?? gqlContext;
  }

  return ctx.switchToHttp().getRequest();
}
