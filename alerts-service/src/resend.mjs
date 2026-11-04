// The few Resend calls this service makes, over fetch. Subscribers are Resend contacts in one segment
// (RESEND_SEGMENT_ID); subscribing adds a contact to it, unsubscribing removes it from it. A contact Resend marks
// globally unsubscribed is never mailed.
//   https://resend.com/docs/api-reference/contacts  ·  https://resend.com/docs/api-reference/emails/send-batch-emails

const API = 'https://api.resend.com';

export class ResendError extends Error {
  constructor(status, body) {
    super(`Resend answered ${status}: ${String(body?.message ?? body ?? '').slice(0, 200)}`);
    this.status = status;
  }
}

export function createResend({ apiKey, fetchImpl = fetch }) {
  async function call(method, path, body, headers = {}) {
    const res = await fetchImpl(API + path, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) throw new ResendError(res.status, json);
    return json;
  }

  return {
    /** Adds `email` to the segment, creating the contact when it does not exist yet. */
    async subscribe(email, segmentId) {
      try {
        await call('POST', '/contacts', { email, unsubscribed: false, segments: [{ id: segmentId }] });
      } catch (err) {
        // The contact exists already (it may be subscribed to the other site's segment): add it to this one.
        if (!(err instanceof ResendError) || ![409, 422].includes(err.status)) throw err;
        await call('POST', `/contacts/${encodeURIComponent(email)}/segments/${encodeURIComponent(segmentId)}`);
      }
    },

    async unsubscribe(email, segmentId) {
      try {
        await call('DELETE', `/contacts/${encodeURIComponent(email)}/segments/${encodeURIComponent(segmentId)}`);
      } catch (err) {
        if (err instanceof ResendError && err.status === 404) return; // not subscribed: the outcome is the same
        throw err;
      }
    },

    /** Every address in the segment that may be mailed. */
    async subscribers(segmentId) {
      const out = [];
      let after = null;
      for (let page = 0; page < 1000; page++) {
        const q = new URLSearchParams({ segment_id: segmentId, limit: '100' });
        if (after) q.set('after', after);
        const res = await call('GET', `/contacts?${q}`);
        const data = res?.data ?? [];
        for (const c of data) if (!c.unsubscribed && c.email) out.push(c.email);
        if (!res?.has_more || !data.length) break;
        after = data.at(-1).id;
      }
      return out;
    },

    async sendOne(email) {
      return call('POST', '/emails', email);
    },

    /** Up to 100 emails per call. */
    async sendBatch(emails, idempotencyKey) {
      return call('POST', '/emails/batch', emails, idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {});
    },
  };
}
