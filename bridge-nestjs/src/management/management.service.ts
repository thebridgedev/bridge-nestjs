import { Inject, Injectable } from '@nestjs/common';
import type { BridgeServer } from '@nebulr-group/bridge-auth-core/server';
import { BRIDGE_OPTIONS, BRIDGE_SERVER, type BridgeModuleOptions } from '../options';
import { createBridgeManagement, type BridgeManagement } from './management';

// eslint-disable-next-line @typescript-eslint/no-empty-interface, @typescript-eslint/no-unsafe-declaration-merging
export interface BridgeManagementService extends BridgeManagement {}

/**
 * The management client, injectable: `workspaces`, `workspace(id)` (its
 * members, invites and billing), `plans`, `roles`, `users`, and
 * `forCaller(request)` for the calling person's keys and workspace keys.
 * Uses the module's `appKey`.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
@Injectable()
export class BridgeManagementService {
  constructor(@Inject(BRIDGE_SERVER) server: BridgeServer, @Inject(BRIDGE_OPTIONS) options: BridgeModuleOptions) {
    Object.assign(
      this,
      createBridgeManagement({
        server,
        ...(options.appKey === undefined ? {} : { appKey: options.appKey }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch as typeof fetch }),
      }),
    );
  }
}
