/** A workspace id as Bridge writes them; anything else is not passed on, since auth-core's `forRequest` throws on it. */
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The workspace an app key names for its flag results: `Bridge-Workspace`, or `x-tenant-id` as 0.x callers send it. Only a
 * valid id is passed on; a key that names none, or an invalid one, gets its own results as before. For keys only: a
 * person's results are for their own workspace, and auth-core sends the id with a key alone.
 */
export function workspaceNamedBy(read: (name: string) => string | undefined): string | undefined {
  const named = (read('bridge-workspace') ?? read('x-tenant-id'))?.trim();
  return named !== undefined && WORKSPACE_ID.test(named) ? named : undefined;
}

/** The same, read from a request's headers as a server framework keeps them (lower-cased names, a repeated one as an array). */
export function workspaceInHeaders(headers: Readonly<Record<string, string | readonly string[] | undefined>> | undefined): string | undefined {
  return workspaceNamedBy((name) => {
    const value = headers?.[name];
    return Array.isArray(value) ? (value[0] as string | undefined) : (value as string | undefined);
  });
}
