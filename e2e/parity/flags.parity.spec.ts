/**
 * The management client's flags area with the app key: make, read, change on a named revision, refuse a stale one,
 * kill and restore, schedule, export, import and delete.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { BridgeConflictError, BridgeManagementService } from '@nebulr-group/bridge-nestjs';
import { describeParity, startDemo } from './support/stage';

describeParity('management client: flags', (env) => {
  let app: INestApplication;
  let flags: BridgeManagementService['flags'];
  const run = randomUUID().slice(0, 8);
  const key = `parity-mgmt-${run}`;
  const imported = `parity-mgmt-imp-${run}`;
  const made: string[] = [];

  beforeAll(async () => {
    app = await startDemo(env);
    flags = app.get(BridgeManagementService).flags;
  }, 60_000);

  afterAll(async () => {
    for (const each of made) await flags.delete(each).catch(() => undefined);
    await app.close();
  });

  it('makes a flag, lists it, and reads it with its ETag', async () => {
    const created = await flags.create({ key, description: 'Parity suite', state: 'off', valueType: 'boolean', onValue: true, offValue: false });
    made.push(key);
    expect(created).toMatchObject({ key, state: 'off', valueType: 'boolean' });
    expect((await flags.list()).map((flag) => flag.key)).toContain(key);
    expect((await flags.list({ fields: ['key'] })).find((flag) => flag.key === key)).toEqual({ key });
    const read = await flags.getWithETag(key);
    expect(read.flag.key).toBe(key);
    expect(read.etag).toBe(`"${String(read.flag.revision)}"`);
    expect(await flags.get(key)).toMatchObject({ key, revision: read.flag.revision });
  });

  it('changes a flag on the revision named, and refuses a stale one with a typed conflict', async () => {
    const first = await flags.getWithETag(key);
    const changed = await flags.update(key, { description: 'Parity suite, changed' }, { ifMatch: first.etag });
    expect(changed).toMatchObject({ key, description: 'Parity suite, changed' });
    expect(changed.revision).toBeGreaterThan(first.flag.revision);
    // The ETag of the first read is out of date now.
    const stale = await flags.update(key, { description: 'Lost' }, { ifMatch: first.etag }).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(BridgeConflictError);
    expect(stale).toMatchObject({ kind: 'conflict', ifMatch: first.etag });
    expect([409, 412]).toContain((stale as BridgeConflictError).status);
    expect((await flags.get(key)).description).toBe('Parity suite, changed');
    // A change that should win names the current revision, read just before.
    expect(await flags.update(key, { state: 'on' }, { ifMatch: (await flags.getWithETag(key)).etag })).toMatchObject({ key, state: 'on' });
    // One that names none is not sent.
    await expect((flags.update as (...args: unknown[]) => Promise<unknown>)(key, { state: 'off' })).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('kills a flag and restores it', async () => {
    expect(await flags.kill(key)).toMatchObject({ key, state: 'off' });
    expect(await flags.restore(key)).toMatchObject({ key, state: 'on' });
  });

  it('schedules a change, lists it, and cancels it', async () => {
    const at = new Date(Date.now() + 60 * 60 * 1000);
    const { etag } = await flags.getWithETag(key);
    const scheduled = await flags.schedules.create(key, { at, patch: { state: 'off' } }, { ifMatch: etag });
    expect(scheduled).toMatchObject({ flag: key, status: 'pending' });
    expect((await flags.schedules.list({ flag: key })).map((schedule) => schedule.id)).toContain(scheduled.id);
    expect(await flags.schedules.cancel(scheduled.id)).toEqual({ cancelled: true });
    expect((await flags.schedules.list({ flag: key })).filter((schedule) => schedule.status === 'pending')).toEqual([]);
  });

  it('exports the flags, and imports a bundle: a dry run changes nothing, the import makes the flag', async () => {
    const bundle = await flags.export();
    expect(bundle.flags.map((flag) => flag['key'])).toContain(key);
    const extra = { version: 1, flags: [{ key: imported, description: 'Parity import', state: 'off', valueType: 'boolean', onValue: true, offValue: false }] };
    expect(await flags.import(extra, { dryRun: true })).toMatchObject({ dryRun: true, created: [imported] });
    await expect(flags.get(imported)).rejects.toMatchObject({ kind: 'not-found' });
    expect(await flags.import(extra)).toMatchObject({ dryRun: false, created: [imported] });
    made.push(imported);
    expect(await flags.get(imported)).toMatchObject({ key: imported, state: 'off' });
  });

  it('deletes a flag on the revision named, and refuses a stale one', async () => {
    const first = await flags.getWithETag(imported);
    await flags.update(imported, { description: 'Changed once more' }, { ifMatch: first.etag });
    await expect(flags.delete(imported, { ifMatch: first.etag })).rejects.toBeInstanceOf(BridgeConflictError);
    expect(await flags.delete(imported, { ifMatch: (await flags.getWithETag(imported)).etag })).toEqual({ deleted: true });
    await expect(flags.get(imported)).rejects.toMatchObject({ kind: 'not-found' });
  });
});
