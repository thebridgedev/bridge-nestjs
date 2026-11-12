/**
 * Bridge's signed webhooks, from a delivery Bridge really made: a new workspace of the test app is delivered to an address
 * the harness can read back, and the package's own verifier checks the stored delivery, byte for byte; the demo's route takes
 * it; a replay arrives with the same event id and is handled once.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { signWebhookPayload, verifyWebhook, WebhookSignatureError } from '@nebulr-group/bridge-nestjs';
import { received } from '../../demo/src/webhooks.controller';
import { describeParity, eventually, Harness, newOwner, startDemo } from './support/stage';

interface Kept {
  headers: Record<string, string>;
  body: string;
}

describeParity('webhooks', (env) => {
  const run = env.harness === null ? describe.skip : describe;
  run('a delivery Bridge made', () => {
    let app: INestApplication;
    let harness: Harness;
    let secret = '';
    let first: Kept;
    let eventId = '';

    const arrived = async (since: number, count: number): Promise<Kept[]> =>
      (
        await eventually(async () => {
          const all = await harness.call<Kept[]>('GET', `/received?since=${String(since)}`);
          const mine = all.filter((each) => each.headers['bridge-event-type'] === 'tenant.created' && each.body.includes(`"app_id":"${env.appId}"`));
          if (mine.length < count) throw new Error(`${String(mine.length)} of ${String(count)} deliveries have arrived`);
          return mine;
        }, 90_000, 2_000)
      ).value;

    beforeAll(async () => {
      harness = new Harness(env.harness as string);
      await harness.call('POST', '/webhook/enable', { events: ['tenant.created'] });
      secret = (await harness.call<{ secret: string }>('POST', '/webhook/rotate')).secret;
      app = await startDemo(env, { webhookSecrets: [secret] });
      const since = Date.now();
      await newOwner(env, 'webhook');
      [first] = await arrived(since, 1);
      eventId = first?.headers['bridge-event-id'] ?? '';
    }, 180_000);

    afterAll(async () => {
      await app.close();
    });

    it('checks out with the package\'s verifier: signature byte for byte, timestamp, event id and type', () => {
      const event = verifyWebhook({ body: first.body, headers: first.headers, secrets: secret });
      expect(event.id).toBe(eventId);
      expect(event.type).toBe('tenant.created');
      expect(Math.abs(Date.now() / 1000 - event.timestamp)).toBeLessThan(600);
      expect((event.payload as Record<string, unknown>)['app_id']).toBe(env.appId);
      const t = /t=(\d+)/.exec(first.headers['bridge-signature'] ?? '')?.[1];
      expect(first.headers['bridge-signature']).toContain(`v1=${signWebhookPayload(secret, Number(t), first.body)}`);
    });

    it('refuses the same delivery with a changed byte, another secret, or a stale clock', () => {
      const attempt = (over: { body?: string; secrets?: string; now?: number }) => () => verifyWebhook({ body: first.body, headers: first.headers, secrets: secret, ...over });
      expect(attempt({ body: `${first.body} ` })).toThrow(WebhookSignatureError);
      expect(attempt({ secrets: 'whsec_not-the-secret' })).toThrow(WebhookSignatureError);
      expect(attempt({ now: Date.now() + 10 * 60_000 })).toThrow(expect.objectContaining({ reason: 'too-old' }));
    });

    it('is taken by the demo\'s webhook route, and refused with a changed byte', async () => {
      const send = (body: string) => {
        let call = request(app.getHttpServer()).post('/webhooks/bridge').set('content-type', 'application/json');
        for (const [name, value] of Object.entries(first.headers)) if (name.startsWith('bridge-')) call = call.set(name, value);
        return call.send(body);
      };
      expect((await send(first.body)).status).toBe(204);
      expect((await send(`${first.body} `)).status).toBe(401);
      expect(received.filter((each) => each.id === eventId)).toHaveLength(1);
    });

    it('delivers a replay with the same event id, checked and handled once', async () => {
      const since = Date.now();
      await harness.call('POST', '/webhook/replay', { eventId });
      const again = (await arrived(since - 2_000, 1)).filter((each) => each.headers['bridge-event-id'] === eventId);
      expect(again.length).toBeGreaterThanOrEqual(1);
      const replay = again[again.length - 1] as Kept;
      expect(verifyWebhook({ body: replay.body, headers: replay.headers, secrets: secret }).id).toBe(eventId);
      const answer = await request(app.getHttpServer())
        .post('/webhooks/bridge')
        .set('content-type', 'application/json')
        .set('bridge-event-id', replay.headers['bridge-event-id'] ?? '')
        .set('bridge-event-type', replay.headers['bridge-event-type'] ?? '')
        .set('bridge-signature', replay.headers['bridge-signature'] ?? '')
        .send(replay.body);
      expect(answer.status).toBe(204);
      expect(received.filter((each) => each.id === eventId)).toHaveLength(1);
    }, 120_000);
  });
});
