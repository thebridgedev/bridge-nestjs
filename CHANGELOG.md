# Changelog

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
