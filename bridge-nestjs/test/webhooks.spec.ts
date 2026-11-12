import { createHmac } from 'node:crypto';
import { verifyWebhook, webhookSignatureHeader, WebhookSignatureError } from '../src';

/** Bridge's signer, as the webhooks service writes it: `t=<t>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, newest secret first. */
function bridgeSignature(secrets: string[], body: string, timestamp: number): string {
  return [`t=${timestamp}`, ...secrets.map((secret) => `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`)].join(',');
}

const secret = `whsec_${'ab'.repeat(32)}`;
const previous = `whsec_${'cd'.repeat(32)}`;
const body = '{"id":"evt_1","type":"member.added","data":{"workspace":"ws-1","name":"Åsa"}}';
const now = 1_800_000_000_000;
const t = now / 1000;

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof WebhookSignatureError) return error.reason;
    throw error;
  }
  return 'passed';
}

describe('webhook signatures', () => {
  it('makes the same header as Bridge, byte for byte', () => {
    expect(webhookSignatureHeader([secret, previous], body, t)).toBe(bridgeSignature([secret, previous], body, t));
  });

  it('takes Bridge\'s header, as a string or as raw bytes', () => {
    const headers = { 'Bridge-Signature': bridgeSignature([secret], body, t), 'Bridge-Event-Id': 'evt_1', 'Bridge-Event-Type': 'member.added' };
    const event = verifyWebhook({ body, headers, secrets: secret, now });
    expect(event).toEqual({ id: 'evt_1', type: 'member.added', timestamp: t, payload: JSON.parse(body) });
    expect(verifyWebhook({ body: Buffer.from(body, 'utf8'), headers, secrets: secret, now }).payload).toEqual(JSON.parse(body));
  });

  it('passes during a rotation\'s overlap whichever secret the receiver still holds', () => {
    const header = bridgeSignature([secret, previous], body, t);
    expect(refusal(() => verifyWebhook({ body, headers: header, secrets: previous, now }))).toBe('passed');
    expect(refusal(() => verifyWebhook({ body, headers: header, secrets: secret, now }))).toBe('passed');
    // A receiver given both secrets passes a delivery signed with either.
    expect(refusal(() => verifyWebhook({ body, headers: bridgeSignature([previous], body, t), secrets: [secret, previous], now }))).toBe('passed');
  });

  it('refuses what does not check out', () => {
    const good = bridgeSignature([secret], body, t);
    expect(refusal(() => verifyWebhook({ body, headers: good, secrets: previous, now }))).toBe('mismatch');
    expect(refusal(() => verifyWebhook({ body: body.replace('Åsa', 'Asa'), headers: good, secrets: secret, now }))).toBe('mismatch');
    expect(refusal(() => verifyWebhook({ body, headers: good, secrets: secret, now: now + 301_000 }))).toBe('too-old');
    expect(refusal(() => verifyWebhook({ body, headers: {}, secrets: secret, now }))).toBe('missing');
    expect(refusal(() => verifyWebhook({ body, headers: 'v1=abc', secrets: secret, now }))).toBe('malformed');
    expect(refusal(() => verifyWebhook({ body, headers: `t=${t},v1=zz`, secrets: secret, now }))).toBe('mismatch');
    expect(refusal(() => verifyWebhook({ body, headers: good, secrets: [], now }))).toBe('no-secret');
  });
});
