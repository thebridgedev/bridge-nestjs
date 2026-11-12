# Changelog

## [Unreleased]

### Added

- **Flags in the management client.** `management.flags` lists, reads, makes, changes, deletes, kills, restores, schedules, exports and imports the app's flags with your app key.
- **Change a flag on the revision you read.** `flags.getWithETag(key)` gives the flag and its ETag; `update` requires `ifMatch` (Bridge refuses a flag change that names no revision), and `delete` and `schedules.create` take it, sent as `If-Match`. A change made on an out-of-date revision throws `BridgeConflictError` (a `BridgeError` of kind `conflict`). `management.request` takes `ifMatch` too.
- **A missing revision is `invalid`.** Bridge's `428` (a change that must name the revision it is made on) is now `kind: 'invalid'`; it was `unavailable`.

## [1.0.0-alpha.1] - 2026-11-12

The first alpha for the new Bridge. It checks tokens with the same verifier as `@nebulr-group/bridge-auth-core` 1.0 and works with the new Bridge only.

### Added

- **Access taken away within seconds.** The guard follows your app's revocation list, so a session that ended, a removed member or a revoked key is refused within seconds instead of when the token expires. Writes are checked against a list at most 30 seconds behind; `@Strict()` does the same for a sensitive read. While Bridge cannot be checked the guard answers 503, never yes.
- **Keys.** `x-api-key` takes personal, service account and app keys; the key becomes the caller.
- **`@CurrentActor()`.** The verified caller: who it is, the workspace, the app, the session and the workspace's standing.
- **`@Flag(key, fallback)` and `@Flags()`.** A flag's value, or the whole set, worked out by Bridge for the caller.
- **`@Meter(metric)`.** Counts usage for the caller's workspace once the handler succeeds, in batches that are never counted twice.
- **Management client.** `BridgeManagementService`: workspaces, members, invites, plans and each workspace's billing with your app key or a workspace key; the calling person's keys and their workspace's keys with their own token.
- **Webhooks.** `@BridgeWebhook()` and `verifyWebhook()` check Bridge's webhook signature, with two secrets during a rotation's 24-hour overlap.
- **Management calls time out.** A call Bridge does not answer within 10 seconds fails with `kind: 'network'`; set `managementTimeoutMs` (or `timeoutMs` for `createBridgeManagement`) to change it.

### Changed (breaking)

- **The issuer is the only address.** `forRoot({ issuer })` or `BRIDGE_ISSUER` replaces `appId`, `apiBaseUrl`, `introspectionUrl`, `apiTokenJwksUrl` and `userJwksUrl`.
- **`@CurrentUser()` and `@CurrentTenant()` are removed.** Use `@CurrentActor()`. The Actor carries no role, privileges or plan: gate with a flag.
- **`@RequirePrivilege()` and a rule's `tokenPrivilege` are removed.** Put the privilege in a flag's rule and use `@RequireFlag`.
- **Plan limits are flag rules.** `@RequireQuota`, `@SyncQuota`, `@RequireEntitlement` and `BridgeQuotaService` are removed. Gate with `@RequireFlag` and count with `@Meter`.
- **A flag that is off answers `403 FEATURE_OFF`** unless a plan feature keeps it off (`402 FEATURE_NOT_IN_PLAN`, unchanged). `FEATURE_NOT_PERMITTED` is no longer sent.
- **Flags come from Bridge for the caller.** The `/flags` entry point, `BridgeFlagsModule`, `BridgeFlagsService`, `BridgeContextInterceptor` and the auth-core flag re-exports are removed; a call with a key gets every flag's fallback.
- **`JwksService`, `FeatureFlagService`, `BridgeHttpService`, `BridgeConfigService`, `TenantScope` and `BridgeService.fromJwt()` are removed.** `BridgeService` checks and reads for the caller; `BridgeManagementService` calls Bridge's API.
- **`RequireFlag` and `RequireFeatureFlag` are the same decorator**, from the main entry point.
- **Node 20.19 or later.**
- **GraphQL rules name the resolver, not the operation.** A rule's `graphqlOperation` is removed: the client chooses an operation's name, so a rule on it could be opened or skipped by renaming the operation. Use `graphqlField: 'Query.field'` (or `Mutation.…`), checked for each field the document asks for, or `@Public()` / `@RequireFlag()` on the resolver. The module refuses to start with a `graphqlOperation` rule.
- **Path rules match the route, not the URL.** A rule's `path` is matched against the route the router picked, as you declared it, ignoring case and a trailing slash. A different case, a trailing or doubled slash or an escaped letter can no longer get a request past its rule. Write a rule for a parameter route as `/users/*` or `/users/:id`, not as a concrete URL.

Unchanged: `BridgeModule.forRoot()` / `forRootAsync()`, `BridgeAuthGuard`, `guard.global`, `guard.defaultAccess`, route rules' `privilege` and `featureFlag`, `@Public()`, `@AcceptAuth()`, `@RequireFeatureFlag()`, `FeatureNotInPlanException`, `FeatureForbiddenException`, `featureRefusalBody`, `BRIDGE_DEFAULTS`.

## [0.8.0] - 2026-09-30

### Added

- **Plan limits as one decorator.** `@RequireQuota` on the handler that creates something refuses the request once the workspace is at its plan limit, and records the usage after a successful response, so calls made straight to your API are held to the same limit as your UI. For things that can be deleted, pass your own count and add `@SyncQuota` to the delete handler; deleting one frees room again. A refused request answers 402 with the limit's name, the numbers and where to upgrade.
- **Seat limits.** A seat limit your app names is counted by Bridge from the workspace's members, pending invites included, so the same decorator on your own invite handler stops invites at the plan's limit.
- **Flag rules see role, privileges and plan.** Backend flag checks now know the person's role and privileges and the workspace's plan and plan features, with no wiring, so a rule gives the same answer on the backend as in the browser. A plan change reaches the backend without waiting for the person to sign in again.
- **A flag-gated endpoint says why it refused.** `@RequireFeatureFlag` answers 402 when the feature is not on the workspace's plan, and 403 when the person is not allowed or the feature is switched off, naming the reason.
- **Settings from the environment.** `BridgeModule.forRoot()` with no settings reads the app id and the Bridge address from the environment.
- **A hint for route rules that miss the global prefix.** When a route rule fails to match only because your app mounts its routes under a global prefix such as `/api`, the log says once which path to write, or to put `@Public()` on the handler.
- **Double-counting warning.** Outside production, an endpoint that counts usage names its limit, so the browser plugins can warn during development when the browser and the backend both count the same thing.

### Changed

- **Breaking: every gate is a feature flag.** `@RequireRole` and the route rules on role, privilege, plan and plan feature are removed. Gate the route with `@RequireFeatureFlag` and put the role, privilege or plan feature in the flag's rule.
- **Auth core comes with the plugin.** `@nebulr-group/bridge-auth-core` now installs as a dependency of this package; there is no second package to add.
- **Shorter guides.** The guides describe the few lines a backend needs, and one page explains how roles, plans, limits and flags fit together.

### Fixed

- **NestJS 12.** The package installs on NestJS 12 as well as 10 and 11. Previously a newly created NestJS project failed at the install step.
- **Documentation links.** Three pages in the published guides linked to addresses with no page behind them; they now resolve.
