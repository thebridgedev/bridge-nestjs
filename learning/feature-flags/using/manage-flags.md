# Manage flags from your server

Everything Control Center's flag screens do is also a call your own server can make: make a flag, change its rule, kill it, schedule a change, copy the lot to another app. `BridgeManagementService` has them as `flags`. They use your app key, so they belong on your server and in your scripts, never in a browser.

```typescript
import { Injectable } from '@nestjs/common';
import { BridgeManagementService } from '@nebulr-group/bridge-nestjs';

@Injectable()
export class Rollouts {
  constructor(private readonly management: BridgeManagementService) {}

  async startRollout() {
    const { flags } = this.management;
    await flags.create({ key: 'new-checkout', description: 'The new checkout', state: 'off', valueType: 'boolean', onValue: true, offValue: false });
    await flags.update('new-checkout', { state: 'on' }, { ifMatch: (await flags.getWithETag('new-checkout')).etag });
  }
}
```

The key needs `flags.flags:read` to read, `flags.flags:write` to make, change, kill, schedule and import, and `FLAG_DELETE` to delete. Give it only the ones your code uses. Without `BridgeModule`, `createBridgeManagement({ server, appKey })` gives the same `flags`.

## The calls

| Call | Does |
|---|---|
| `flags.list({ fields? })` | Every flag. `fields: ['key', 'state']` trims each answer to those fields |
| `flags.get(key, { fields? })` | One flag |
| `flags.getWithETag(key)` | One flag and its ETag, for a change that names the revision it was made on |
| `flags.create({ key, ... })` | Makes a flag. A key that exists is refused with `kind: 'conflict'` |
| `flags.update(key, patch, { ifMatch })` | Changes the fields you give. `rule: null` clears the rule. `ifMatch` is required |
| `flags.delete(key, { ifMatch? })` | Deletes a flag |
| `flags.kill(key)` / `flags.restore(key)` | Switches a flag off, keeping its rule, and back to the state it had. Needs no revision |
| `flags.schedules.list({ flag? })` | The waiting and past scheduled changes, of one flag or all |
| `flags.schedules.create(key, { at, patch }, { ifMatch? })` | A change at a time, from now to a year ahead |
| `flags.schedules.cancel(scheduleId)` | Cancels a waiting change |
| `flags.export()` | The flags and segments as a bundle |
| `flags.import(bundle, { dryRun? })` | Makes and changes what the bundle holds, whole or not at all. It never deletes. `dryRun: true` answers what it would do and does nothing |

Every flag you get back has a `revision`, which changes with every change to it. For a route this client has no method for yet, `management.request('GET', 'flags', '/segments')` calls it with the same key.

## Change a flag on the revision you read

Two people, or a person and a script, can change the same flag. To make sure a change does not overwrite one you never saw, read the flag, then change it on the revision you read:

```typescript
import { BridgeConflictError } from '@nebulr-group/bridge-nestjs';

const { flag, etag } = await flags.getWithETag('new-checkout');
try {
  await flags.update('new-checkout', { rule: nextRule(flag.rule) }, { ifMatch: etag });
} catch (error) {
  if (error instanceof BridgeConflictError) {
    // Someone changed the flag after you read it. Read it again and decide again.
  } else {
    throw error;
  }
}
```

`ifMatch` takes the ETag a read gave, or the flag's `revision` as a number. The client sends it as `If-Match`. When the flag has changed since, Bridge refuses the change and the client throws a `BridgeConflictError`, which is a `BridgeError` with `kind: 'conflict'`. Its `ifMatch` says which revision your change was made on.

`update` requires `ifMatch`, because Bridge refuses a change to a flag that names no revision: that is what stops one change from silently overwriting another. `delete` and `schedules.create` take `ifMatch` too, and do not need one.

When the change should win whatever happened in between, read the current revision just before and name it:

```typescript
await flags.update('new-checkout', { state: 'on' }, { ifMatch: (await flags.getWithETag('new-checkout')).etag });
```

A `BridgeConflictError` is only a stale revision. A key that is already taken, on `create`, is a plain `BridgeError` of the same kind, since there is no revision to read again.

## Copy flags to another app

```typescript
const bundle = await flags.export();

// `otherServer` is the other app's `createBridgeServer({ issuer })`.
const other = createBridgeManagement({ server: otherServer, appKey: process.env.OTHER_APP_KEY });
const plan = await other.flags.import(bundle, { dryRun: true });   // what it would do
await other.flags.import(bundle);
```

An import is checked whole before anything is written and applies whole or not at all. Flags the other app has and the bundle does not are left alone: `extraneous` in the answer lists them, and deleting them is yours to do. A scheduled change is not carried in a bundle; make it again on the other app.
