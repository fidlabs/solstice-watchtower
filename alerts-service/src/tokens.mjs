// Signed, expiring tokens for the confirm and unsubscribe links. No database: the token carries the address and what it
// may do, and the HMAC proves this service issued it.
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function sign(secret, payload) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${mac}`;
}

/** Returns the payload when the token is genuine, unexpired and for `action`; otherwise null. */
export function verify(secret, token, action, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  let given;
  try {
    given = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload.a !== action || typeof payload.e !== 'string') return null;
  if (payload.x !== undefined && nowMs > payload.x) return null;
  return payload;
}

/** Constant-time comparison of a presented bearer token with the configured one. */
export function sameSecret(presented, expected) {
  const a = createHash('sha256').update(String(presented ?? '')).digest();
  const b = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

/** A short, non-reversible tag for logs, so no address is ever written to a log. */
export const tag = (email) => createHash('sha256').update(email).digest('hex').slice(0, 10);
