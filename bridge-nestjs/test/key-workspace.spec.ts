import type { BridgeServer, RequestLike } from '@nebulr-group/bridge-auth-core/server';
import { BridgeService } from '../src';
import { workspaceInHeaders } from '../src/flags/key-workspace';

/** A key may name the workspace whose plan its flag results use (Bridge-Workspace, or x-tenant-id as 0.x sends it). */
describe('the workspace a key names for its flags', () => {
  it('reads Bridge-Workspace, then x-tenant-id, takes the first of a repeated header, and keeps only a valid id', () => {
    expect(workspaceInHeaders({ 'bridge-workspace': 'ws_1' })).toBe('ws_1');
    expect(workspaceInHeaders({ 'x-tenant-id': ' ws-2 ' })).toBe('ws-2');
    expect(workspaceInHeaders({ 'bridge-workspace': 'a', 'x-tenant-id': 'b' })).toBe('a');
    expect(workspaceInHeaders({ 'bridge-workspace': ['c', 'd'] })).toBe('c');
    expect(workspaceInHeaders({ 'bridge-workspace': '../x' })).toBeUndefined();
    expect(workspaceInHeaders({ 'bridge-workspace': 'x'.repeat(65) })).toBeUndefined();
    expect(workspaceInHeaders({ 'bridge-workspace': '' })).toBeUndefined();
    expect(workspaceInHeaders({})).toBeUndefined();
    expect(workspaceInHeaders(undefined)).toBeUndefined();
  });

  it('BridgeService.flags hands the id to auth-core with the request, and nothing when there is none or it is invalid', async () => {
    const calls: unknown[][] = [];
    const server = { flags: { forRequest: async (...args: unknown[]) => void calls.push(args) } } as unknown as BridgeServer;
    const service = new BridgeService(server);
    const keyed = (headers: Record<string, string>): RequestLike => ({ headers: { 'x-api-key': 'k', ...headers } });
    await service.flags(keyed({ 'bridge-workspace': 'ws-9' }));
    await service.flags(keyed({ 'x-tenant-id': 'ws-8' }));
    await service.flags(keyed({ 'bridge-workspace': 'no good' }));
    await service.flags(keyed({}));
    expect(calls.map((call) => call[2])).toEqual([{ workspace: 'ws-9' }, { workspace: 'ws-8' }, {}, {}]);
  });
});
