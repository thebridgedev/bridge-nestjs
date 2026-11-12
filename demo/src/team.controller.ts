import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { BridgeManagementService, RequireFlag } from '@nebulr-group/bridge-nestjs';

@Controller('team')
export class TeamController {
  constructor(private readonly management: BridgeManagementService) {}

  /** The caller's workspace members, read as the caller: Bridge applies their privileges. */
  @RequireFlag('bridge-team-manage')
  @Get('members')
  members(@Req() request: { headers: unknown }) {
    return this.management.forCaller(request).workspace.members.list();
  }

  /** A key for the caller's workspace, for its CI or integrations, holding the privileges asked for. Shown once. */
  @RequireFlag('bridge-team-manage')
  @Post('workspace-keys')
  createKey(@Req() request: { headers: unknown }, @Body() body: { name: string; privileges?: string[] }) {
    return this.management.forCaller(request).workspaceKeys.create({ name: body.name, ...(body.privileges === undefined ? {} : { privileges: body.privileges }) });
  }
}
