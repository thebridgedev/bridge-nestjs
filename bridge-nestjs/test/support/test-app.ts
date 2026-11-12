import { Body, Controller, Get, INestApplication, Post, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AcceptAuth,
  BridgeManagementService,
  BridgeModule,
  BridgeService,
  BridgeWebhook,
  CurrentActor,
  Flag,
  Flags,
  FlagSet,
  Meter,
  Public,
  RequireFlag,
  Strict,
  WebhookEvent,
  type Actor,
  type BridgeModuleOptions,
  type BridgeWebhookEvent,
} from '../../src';
import type { SignedIssuer } from './signed-issuer';

@Controller()
class TestController {
  constructor(
    private readonly bridge: BridgeService,
    private readonly management: BridgeManagementService,
  ) {}

  @Get('me')
  me(@CurrentActor() actor: Actor) {
    return { actor };
  }

  @Get('workspace-id')
  workspaceId(@CurrentActor('workspaceId') workspaceId: string) {
    return { workspaceId };
  }

  @Public()
  @Get('public')
  open(@CurrentActor() actor: Actor | null) {
    return { actor };
  }

  @Post('notes')
  write(@Body() body: unknown) {
    return { saved: body };
  }

  @Strict(false)
  @Post('relaxed')
  relaxed() {
    return { ok: true };
  }

  @RequireFlag('reports')
  @Get('reports')
  reports() {
    return { ok: true };
  }

  @RequireFlag({ any: ['reports', 'reports-beta'] })
  @Get('reports-any')
  reportsAny() {
    return { ok: true };
  }

  @RequireFlag({ all: ['reports', 'export'] })
  @Get('reports-all')
  reportsAll() {
    return { ok: true };
  }

  @Get('page-size')
  async pageSize(@Flag('page-size', 20) size: number, @Flags() flags: FlagSet, @Req() request: object) {
    return { size, reports: flags.enabled('reports'), viaService: await this.bridge.enabled(request as never, 'reports') };
  }

  @AcceptAuth('jwt')
  @Get('people-only')
  peopleOnly() {
    return { ok: true };
  }

  @Meter('tickets.created')
  @Post('tickets')
  createTicket() {
    return { ok: true };
  }

  @Get('open/a/b')
  ruleOpen(@CurrentActor() actor: Actor | null) {
    return { actor };
  }

  @Get('beta')
  ruleBeta() {
    return { ok: true };
  }

  @Get('items/:id')
  ruleItem() {
    return { ok: true };
  }

  @BridgeWebhook()
  @Post('webhooks/bridge')
  webhook(@WebhookEvent() event: BridgeWebhookEvent) {
    return { event };
  }

  @Get('admin/members')
  members() {
    return this.management.workspace('ws-alpha').members.list();
  }
}

export async function startApp(issuer: SignedIssuer, overrides: Partial<BridgeModuleOptions> = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      BridgeModule.forRoot({
        issuer: issuer.issuer,
        appKey: 'app-key-for-tests',
        fetch: issuer.fetch,
        revocationIntervalMs: 50,
        usageFlushMs: 20,
        webhookSecrets: ['whsec_new', 'whsec_old'],
        guard: {
          global: true,
          rules: [
            { path: '/open/**', privilege: 'ANONYMOUS' },
            { path: '/beta', privilege: 'AUTHENTICATED', featureFlag: 'beta' },
            { path: '/items/*', privilege: 'AUTHENTICATED', featureFlag: 'beta' },
          ],
        },
        ...overrides,
      }),
    ],
    controllers: [TestController],
  }).compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  await app.init();
  await app.get(BridgeService).ready;
  return app;
}

/** Waits until `check` passes, or fails after `ms`. */
export async function eventually(check: () => Promise<void>, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
