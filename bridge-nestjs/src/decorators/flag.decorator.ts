import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { FlagSet } from '@nebulr-group/bridge-auth-core/server';
import { bridgeStateOf, requestOf } from '../request-context';

/** The caller's flag results (a `FlagSet`), read once per request. Empty without a person's token. */
export const Flags = createParamDecorator(async (_: unknown, context: ExecutionContext): Promise<FlagSet> => {
  const request = requestOf(context);
  const state = request === null ? undefined : bridgeStateOf(request);
  return state === undefined ? new FlagSet() : state.flags();
});

/**
 * One flag's value for the caller, or `fallback` when Bridge gave none.
 *
 * @example
 *   list(@Flag('page-size', 20) pageSize: number) { … }
 */
export function Flag<T>(key: string, fallback: T): ParameterDecorator {
  return FlagParam({ key, fallback });
}

const FlagParam = createParamDecorator(async (data: { key: string; fallback: unknown }, context: ExecutionContext) => {
  const request = requestOf(context);
  const state = request === null ? undefined : bridgeStateOf(request);
  if (state === undefined) return data.fallback;
  return (await state.flags()).get(data.key, data.fallback);
});
