import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Bridge's webhook signature, checked on the app's server. Framework-free:
 * it needs only the raw body and the headers.
 *
 *   Bridge-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * While a rotated secret's overlap lasts, Bridge signs with both secrets and
 * the header carries one `v1` per secret; a header passes when any `v1`
 * matches any secret given. Give the receiver both secrets for the overlap
 * (the new one first) and drop the old one after.
 */

export const SIGNATURE_HEADER = 'bridge-signature';
export const EVENT_ID_HEADER = 'bridge-event-id';
export const EVENT_TYPE_HEADER = 'bridge-event-type';

/** How old a signature may be, against replays. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type WebhookRefusal = 'no-secret' | 'missing' | 'malformed' | 'too-old' | 'mismatch' | 'not-json';

export class WebhookSignatureError extends Error {
  override readonly name = 'WebhookSignatureError';
  constructor(
    readonly reason: WebhookRefusal,
    message: string,
  ) {
    super(message);
  }
}

export interface BridgeWebhookEvent<T = unknown> {
  /** `Bridge-Event-Id`: the same across retries and replays, so handle each id once. */
  readonly id: string | null;
  /** `Bridge-Event-Type`, such as `workspace.created`. */
  readonly type: string | null;
  /** When it was signed, in unix seconds. */
  readonly timestamp: number;
  /** The body, parsed. */
  readonly payload: T;
}

export interface VerifyWebhookInput {
  /** The body exactly as it arrived: the raw bytes, never a re-serialized object. */
  readonly body: string | Uint8Array;
  /** The request's headers (any case), or just the `Bridge-Signature` value. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>> | string;
  /** The signing secret, or several during a rotation's overlap. */
  readonly secrets: string | readonly string[];
  /** @default 300 */
  readonly toleranceSeconds?: number;
  /** For tests. @default Date.now() */
  readonly now?: number;
}

function headerOf(headers: VerifyWebhookInput['headers'], name: string): string | undefined {
  if (typeof headers === 'string') return name === SIGNATURE_HEADER ? headers : undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/** The `v1=` part for one secret: the same bytes Bridge sends. */
export function signWebhookPayload(secret: string, timestamp: number, body: string | Uint8Array): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(`${String(timestamp)}.`);
  hmac.update(body);
  return hmac.digest('hex');
}

/** A whole `Bridge-Signature` header, as Bridge makes it: for tests and local tools. */
export function webhookSignatureHeader(secrets: string | readonly string[], body: string | Uint8Array, timestamp = Math.floor(Date.now() / 1000)): string {
  const list = typeof secrets === 'string' ? [secrets] : secrets;
  return [`t=${String(timestamp)}`, ...list.map((secret) => `v1=${signWebhookPayload(secret, timestamp, body)}`)].join(',');
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]+$/.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Checks a webhook's signature and age, and returns the event. Throws a
 * `WebhookSignatureError` (answer 400 or 401) when it does not check out.
 */
export function verifyWebhook<T = unknown>(input: VerifyWebhookInput): BridgeWebhookEvent<T> {
  const secrets = (typeof input.secrets === 'string' ? [input.secrets] : [...input.secrets]).filter((secret) => secret !== '');
  if (secrets.length === 0) throw new WebhookSignatureError('no-secret', 'No webhook secret is configured.');
  const header = headerOf(input.headers, SIGNATURE_HEADER);
  if (header === undefined || header === '') throw new WebhookSignatureError('missing', 'The Bridge-Signature header is missing.');

  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === 'v1' && value !== '') signatures.push(value.toLowerCase());
  }
  if (timestamp === null || signatures.length === 0) throw new WebhookSignatureError('malformed', 'The Bridge-Signature header has no timestamp or no v1 signature.');

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > tolerance) throw new WebhookSignatureError('too-old', `The signature is more than ${tolerance} seconds from now.`);

  const matched = secrets.some((secret) => {
    const expected = signWebhookPayload(secret, timestamp as number, input.body);
    return signatures.some((given) => sameHex(given, expected));
  });
  if (!matched) throw new WebhookSignatureError('mismatch', 'No signature matches the configured secrets.');

  const text = typeof input.body === 'string' ? input.body : Buffer.from(input.body).toString('utf8');
  let payload: T;
  try {
    payload = JSON.parse(text) as T;
  } catch {
    throw new WebhookSignatureError('not-json', 'The signed body is not JSON.');
  }
  return Object.freeze({
    id: headerOf(input.headers, EVENT_ID_HEADER) ?? null,
    type: headerOf(input.headers, EVENT_TYPE_HEADER) ?? null,
    timestamp,
    payload,
  });
}
