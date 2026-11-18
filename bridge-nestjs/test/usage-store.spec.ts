import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BridgeService } from '../src';
import { createSignedIssuer } from './support/signed-issuer';
import { startApp } from './support/test-app';

type Report = { id: string; metric: string; quantity: number; workspace: string; time: string; level?: true };

/** A store that outlives the app using it, as a file does. */
function memoryStore(held: Report[] = []) {
  return {
    held,
    load: () => [...held],
    add: (reports: readonly Report[]) => void held.push(...reports),
    remove: (ids: readonly string[]) => {
      for (const id of ids) {
        const at = held.findIndex((report) => report.id === id);
        if (at !== -1) held.splice(at, 1);
      }
    },
  };
}

describe('usage that waits in a store survives a restart', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('keeps a counted report in the store until Bridge took it, then forgets it', async () => {
    const issuer = await createSignedIssuer();
    const store = memoryStore();
    app = await startApp(issuer, { usageStore: store });
    const token = await issuer.personToken();
    await request(app.getHttpServer()).post('/tickets').set('authorization', `Bearer ${token}`).expect(201);
    expect(store.held).toHaveLength(1);
    await app.get(BridgeService).flush();
    expect(issuer.usage).toEqual([expect.objectContaining({ metric: 'tickets.created', workspace: 'ws-alpha' })]);
    await app.close();
    app = undefined;
    expect(store.held).toEqual([]);
  });

  it('sends what waited when the last process ended, with the ids it was counted with', async () => {
    const issuer = await createSignedIssuer();
    const store = memoryStore([{ id: 'before-the-crash', metric: 'tickets.created', quantity: 3, workspace: 'ws-alpha', time: new Date().toISOString() }]);
    app = await startApp(issuer, { usageStore: store });
    await app.get(BridgeService).flush();
    expect(issuer.usage).toEqual([expect.objectContaining({ id: 'before-the-crash', quantity: 3 })]);
    await app.close();
    app = undefined;
    expect(store.held).toEqual([]);
  });
});
