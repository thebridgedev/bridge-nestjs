import { Controller, Get } from '@nestjs/common';
import { BridgeService, CurrentActor, Public, type Actor } from '@nebulr-group/bridge-nestjs';

@Controller()
export class AppController {
  constructor(private readonly bridge: BridgeService) {}

  /** Open to all: whether token checks are set up and the revocation list is current. */
  @Public()
  @Get()
  health() {
    const status = this.bridge.status();
    return { ok: true, revocationList: status === null ? 'starting' : { ready: status.ready, lagMs: Number.isFinite(status.lagMs) ? status.lagMs : null } };
  }

  /** Who is calling: the verified Actor. */
  @Get('me')
  me(@CurrentActor() actor: Actor) {
    return actor;
  }
}
