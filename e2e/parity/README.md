# Stage parity suite

The demo backend (`demo/`) against a real test app on a deployment of the new Bridge: not a fake issuer, a real one.

```
npm run e2e:parity
```

It is skipped unless it is set up. Run it in a container, from the repository root, with the packages installed in `bridge-nestjs/`.

| Spec | Proves |
|---|---|
| `tokens.parity.spec.ts` | A real person's token is accepted; none, malformed, forged, a refresh token, another app's and an expired token are refused (the expired one waits out the 5 minutes; `PARITY_FAST=1` skips it) |
| `flag-gate.parity.spec.ts` | A route gated by a flag: off refuses and names the flag; on, flipped with the app key, lets the person in within seconds; off again refuses |
| `plan-gate.parity.spec.ts` | A route whose flag needs a plan feature: a workspace on a plan without it is refused with `402 FEATURE_NOT_IN_PLAN` naming the feature and where to upgrade; moved to a plan that has it, the same call is let in |
| `management.parity.spec.ts` | The management client with the app key (workspaces, members, invites, plans, the payer) and with a workspace key (its own workspace only; another refused) |
| `flags.parity.spec.ts` | The management client's flags area with the app key: make, list and read a flag with its ETag; change it on the revision named and refuse a stale one with `BridgeConflictError`; kill, restore, schedule, export, import (dry run and for real) and delete |
| `metering.parity.spec.ts` | What `@Meter` counts reaches Billing's usage for the caller's workspace |
| `webhook.parity.spec.ts` | A delivery Bridge made is checked by `verifyWebhook` (signature byte for byte, timestamp), taken by the demo's route, and its replay arrives with the same event id and is handled once |
| `revocation.parity.spec.ts` | A removed member's token is refused within seconds |

## What the suite needs

All from the environment, set by whoever runs it. A test app, its key and its secrets are made for the run and deleted after.

| Variable | What |
|---|---|
| `PARITY_ISSUER` | The test app's issuer |
| `PARITY_APP_KEY` | The test app's own key. It needs the privileges to make people (`users.passwords:reset`, `USER_READ`, `USER_WRITE`, `TENANT_READ`, `TENANT_WRITE`), read and set the payer (`billing:read`, `billing:manage`) and set and delete flags (`flags.flags:read`, `flags.flags:write`, `FLAG_DELETE`) |
| `PARITY_HARNESS` | Optional. The address of a small local helper for what only the app's developer does. Without it the specs that need it are skipped |
| `PARITY_INBOX_DOMAIN` | Optional. A domain whose mail the run can read, for the invite |

The harness answers, over plain JSON:

| Call | Does |
|---|---|
| `POST /other-app-token` | Returns a real access token of another app |
| `POST /webhook/enable` with `{ events }` | Points the test app's webhook at an address whose deliveries the harness can read |
| `POST /webhook/rotate` | Returns a new webhook signing secret |
| `GET /received?since=<ms>` | The deliveries the address has kept since then, as `{ headers, body }`, exactly as they came |
| `POST /webhook/replay` with `{ eventId }` | Replays that delivery from the app's delivery list |

The suite makes its own people (a workspace and an Owner, through the app's key and a password link, then the public sign-in routes) and its own flags, and never prints a key, token or secret.
