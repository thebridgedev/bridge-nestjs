# @nebulr-group/bridge-nestjs

The Bridge for NestJS backends: every request's access token checked against the app's key set and its revocation list, flag-gated endpoints, "count this", a management client and webhook checks, as one module, a guard and decorators.

> 1.0 is in alpha (`npm i @nebulr-group/bridge-nestjs@alpha`). It works with the new Bridge only. Upgrading from 0.x? See [Upgrading to 1.0](#upgrading-from-0x).

## Install

```bash
npm i @nebulr-group/bridge-nestjs@alpha
```

Node 20.19 or later, NestJS 10, 11 or 12.

## Set up

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { BridgeModule } from '@nebulr-group/bridge-nestjs';

@Module({
  imports: [BridgeModule.forRoot({ guard: { global: true } })],
})
export class AppModule {}
```

| Setting | Environment | What it is |
|---|---|---|
| `issuer` | `BRIDGE_ISSUER` | Your app's issuer, the same one your frontend uses. Everything else (key set, revocation list, API addresses) is read from it. |
| `appKey` | `BRIDGE_APP_KEY` | Your app's own key, for "count this" and the management client. Server only. |
| `webhookSecrets` | `BRIDGE_WEBHOOK_SECRETS` | Your webhook signing secret; two, comma-separated, while a rotation's overlap lasts. |

With `guard: { global: true }` every route needs a valid credential unless it says `@Public()`.

## Who is calling

```ts
import { Controller, Get } from '@nestjs/common';
import { CurrentActor, Public, type Actor } from '@nebulr-group/bridge-nestjs';

@Controller()
export class MeController {
  @Get('me')
  me(@CurrentActor() actor: Actor) {
    return actor; // { kind, id, personId, workspaceId, sessionId, appId, standing }
  }

  @Public()
  @Get('status')
  status() {
    return { ok: true };
  }
}
```

The guard checks `Authorization: Bearer <token>` (a person's access token) or `x-api-key` (a personal, service account or app key):

- the signature against your app's key set, the issuer, the audience and the expiry;
- your app's revocation list, followed every 2 seconds: a session that ended, a member who was removed or a key that was revoked is refused within seconds, not when the token expires;
- writes (POST, PUT, PATCH, DELETE) against a list at most 30 seconds behind. Mark a sensitive read `@Strict()`, or relax a write with `@Strict(false)`.

While Bridge cannot be checked the guard answers `503` with `Retry-After`, never yes. A refused credential gets `401` with `WWW-Authenticate`.

`@AcceptAuth('jwt')` takes only a person's token; `@AcceptAuth('api_token')` only a key.

The Actor has no role and no privileges on purpose: gate with a flag.

## Every gate is a flag

```ts
import { RequireFlag, Flag } from '@nebulr-group/bridge-nestjs';

@RequireFlag('reports')
@Get('reports')
reports(@Flag('reports-page-size', 20) pageSize: number) { … }
```

Your code never reads a role, a privilege or the plan to decide what someone may do. The flag's rule in Bridge says why: a privilege, a plan feature, a rollout. `@RequireFlag({ any: [...] })` and `{ all: [...] }` take several.

A refusal says why:

| Status | `code` | When |
|---|---|---|
| 402 | `FEATURE_NOT_IN_PLAN` | A plan feature keeps the flag off: an upgrade would turn it on. `feature` names it, `fix` is your `manageRoute`. |
| 403 | `FEATURE_OFF` | Anything else. |

Flags are worked out by Bridge for the person whose token came with the request. A call with a key has no person: every flag gives its fallback. `@Flags()` gives the whole set; `BridgeService.flags(request)` the same outside a decorator.

Route rules do the same from one list:

```ts
guard: {
  global: true,
  rules: [
    { path: '/webhooks/**', privilege: 'ANONYMOUS' },
    { path: '/beta/**', privilege: 'AUTHENTICATED', featureFlag: 'beta' },
  ],
}
```

## Count this

```ts
@RequireFlag('tickets-create')
@Meter('tickets.created')
@Post('tickets')
create() { … }
```

Once the handler succeeds, Bridge counts one for the caller's workspace. Counts are sent in batches every few seconds and resent with the same ids, so nothing is counted twice. A limit on a count is a flag rule (`tickets-create` off once the plan's number is reached): the code only counts. `BridgeService.count(actor, metric, n)` counts by hand.

## Management client

`BridgeManagementService` calls Bridge's API with your app key:

```ts
constructor(private readonly management: BridgeManagementService) {}

await this.management.workspaces.create({ name: 'Acme' });
const ws = this.management.workspace(workspaceId);
await ws.members.list();
await ws.invites.send({ email: 'ana@acme.test', role: 'MEMBER' });
await ws.billing.get();
await ws.setSubscription({ plan: 'pro' });
await this.management.plans.list();
```

Some things only a person may do, with their own privileges: their keys, and their workspace's keys. Call those as the person calling your API:

```ts
const caller = this.management.forCaller(request);
await caller.keys.create({ name: 'My laptop' });
await caller.workspaceKeys.create({ name: 'CI', privileges: ['reports:read'] });
```

A workspace key acts for its own workspace: `this.management.withKey(workspaceKey).workspace.members.list()`.

A refusal throws a `BridgeError` with `kind` (`forbidden`, `not-found`, `conflict`, `rate-limited`, …), `status` and `code`. `management.request(method, area, path, options)` reaches a route the client has no method for yet.

## Webhooks

```ts
// main.ts: webhook signatures are checked over the body exactly as it arrived
const app = await NestFactory.create(AppModule, { rawBody: true });

// a controller
@BridgeWebhook()
@Post('webhooks/bridge')
receive(@WebhookEvent() event: BridgeWebhookEvent) {
  // event.id is the same across retries: handle each id once
}
```

`Bridge-Signature: t=<seconds>,v1=<hex HMAC-SHA256>` is checked against your secrets, and must be at most 5 minutes old. When you rotate the secret, Bridge signs with both for 24 hours: set `BRIDGE_WEBHOOK_SECRETS=new,old`, then drop the old one. Outside NestJS, `verifyWebhook({ body, headers, secrets })` does the same.

## Upgrading from 0.x

1.0 works with the new Bridge only, and takes the issuer instead of an app id and an API address.

| 0.x | 1.0 |
|---|---|
| `BridgeModule.forRoot({ appId, apiBaseUrl })`, `BRIDGE_APP_ID` | `BridgeModule.forRoot({ issuer })`, `BRIDGE_ISSUER` |
| `@CurrentUser()`, `@CurrentTenant()`, `BridgeUser`, `BridgeTenant` | `@CurrentActor()` (`personId`, `workspaceId`, …) |
| `@RequirePrivilege()`, `tokenPrivilege` in a rule | A flag whose rule names the privilege, with `@RequireFlag` |
| `@RequireFeatureFlag(...)` | Unchanged; `@RequireFlag` is the same decorator |
| `RouteRule.privilege`, `guard.global`, `guard.defaultAccess`, `@Public()`, `@AcceptAuth()` | Unchanged |
| `@RequireQuota`, `@SyncQuota`, `BridgeQuotaService` | A flag rule for the limit with `@RequireFlag`, and `@Meter` to count |
| `@RequireEntitlement` | A flag whose rule names the plan feature |
| `FeatureForbiddenException` with `FEATURE_NOT_PERMITTED` | `FEATURE_OFF` (402 `FEATURE_NOT_IN_PLAN` is unchanged) |
| `JwksService`, `TokenVerificationError`, `ApiTokenClaims` | `BridgeService.verify(request)`, `BridgeError` |
| `BridgeService.fromJwt(jwt)`, `TenantScope` | `BridgeService` for the caller; `BridgeManagementService` for workspaces, members, billing |
| `BridgeHttpService` | `BridgeManagementService` |
| `@nebulr-group/bridge-nestjs/flags`, `BridgeFlagsModule`, `BridgeFlagsService` | `@RequireFlag`, `@Flag`, `@Flags`, `BridgeService.flags()` |

## Licence

MIT
