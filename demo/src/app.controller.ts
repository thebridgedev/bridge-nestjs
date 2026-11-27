import { Controller, Get } from '@nestjs/common';
import { BridgeService, CurrentActor, Public, type Actor } from '@nebulr-group/bridge-nestjs';

@Controller()
export class AppController {
  constructor(private readonly bridge: BridgeService) {}

  /**
   * Open to all: whether token checks are set up and the revocation list is
   * current. `current.reads` turns false once the list is more than 5 minutes
   * behind and `current.writes` after 90 seconds: from then on this server
   * refuses those requests (503), never lets a removed person in.
   */
  @Public()
  @Get()
  health() {
    const status = this.bridge.status();
    const health = this.bridge.revocationHealth();
    return {
      ok: health.reads,
      revocationList: status === null ? 'starting' : { ready: status.ready, lagMs: Number.isFinite(status.lagMs) ? status.lagMs : null },
      current: { reads: health.reads, writes: health.writes },
      limits: { readsMs: health.maxLagMs, writesMs: health.strictLagMs },
    };
  }

  /** Who is calling: the verified Actor. */
  @Get('me')
  me(@CurrentActor() actor: Actor) {
    return actor;
  }
}
