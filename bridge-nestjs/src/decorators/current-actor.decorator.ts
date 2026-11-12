import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Actor } from '@nebulr-group/bridge-auth-core/server';
import { bridgeStateOf, requestOf } from '../request-context';

/**
 * The verified caller: `{ kind, id, personId, workspaceId, sessionId, appId,
 * standing }`, or null on a public route called without a credential.
 *
 * Pass a field's name for just that field: `@CurrentActor('workspaceId')`.
 * The Actor carries no role or privileges on purpose: gate with a flag.
 */
export const CurrentActor = createParamDecorator((field: keyof Actor | undefined, context: ExecutionContext) => {
  const request = requestOf(context);
  const actor = request === null ? null : (bridgeStateOf(request)?.actor ?? null);
  if (field === undefined) return actor;
  return actor === null ? null : actor[field];
});
