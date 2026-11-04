// The alerts service: email sign-up (double opt-in) and alert fan-out for one site.
//
//   GET  /                      sign-up page
//   POST /api/subscribe         {email} -> a confirmation email. Same answer whether or not the address is known.
//   GET  /confirm?t=            a page with a button; the POST does the work, so a mail scanner that opens links
//   POST /api/confirm           cannot subscribe anybody
//   GET  /unsubscribe?t=        likewise; plus RFC 8058 one-click (POST /api/unsubscribe?t=) for mail clients
//   POST /api/unsubscribe
//   POST /api/alerts            Bearer INGEST_TOKEN. {key, severity, title, text} -> one email per subscriber,
//                               throttled per key, so a job that runs every 15 minutes cannot flood an inbox
//   POST /api/heartbeat         Bearer INGEST_TOKEN. {name, everySeconds} -> if no heartbeat arrives for 3x that, an
//                               alert goes out: the only way to hear about a job that stopped running at all
//   GET  /healthz
//
// State (throttle, heartbeats, rate limits) is in memory. A restart forgets it: at worst one repeated alert, and a
// heartbeat is watched again from its next beat. Subscribers live in Resend, not here.
import { SEVERITIES } from './config.mjs';
import { sameSecret, sign, tag, verify } from './tokens.mjs';

const RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));
const REPEAT_MS = { info: 24 * 3600e3, warn: 6 * 3600e3, critical: 3600e3 };
const CONFIRM_TTL_MS = 48 * 3600e3;
const MAX_BODY = 16 * 1024;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createApp({ config, resend, now = () => Date.now(), log = (...a) => console.log(...a) }) {
  const sentAt = new Map(); // alert key -> { severity, at }
  const heartbeats = new Map(); // name -> { everyMs, last, alerted }
  const hits = new Map(); // limiter key -> [timestamps]

  // ---- helpers ---------------------------------------------------------------------------------------------------
  function limited(key, max, windowMs) {
    const t = now();
    const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (list.length >= max) {
      hits.set(key, list);
      return true;
    }
    list.push(t);
    hits.set(key, list);
    if (hits.size > 10_000) for (const k of [...hits.keys()].slice(0, 5_000)) hits.delete(k); // bounded memory
    return false;
  }

  const clientIp = (req) => {
    const h = req.headers[config.clientIpHeader];
    const v = Array.isArray(h) ? h[0] : h;
    return (v ? v.split(',')[0].trim() : req.socket?.remoteAddress) || 'unknown';
  };

  function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      ...extra,
    });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }
  const json = (res, status, body, extra) => send(res, status, body, 'application/json', extra);

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const type = String(req.headers['content-type'] ?? '');
    if (type.includes('application/json')) {
      try {
        return JSON.parse(raw || '{}');
      } catch {
        throw Object.assign(new Error('invalid JSON'), { status: 400 });
      }
    }
    return Object.fromEntries(new URLSearchParams(raw));
  }

  function cors(req) {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      return { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' };
    }
    return {};
  }

  const page = (title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(config.siteName)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1b1b1b}h1{font-size:1.4rem}
input[type=email]{width:100%;padding:.6rem;font:inherit;box-sizing:border-box}button{margin-top:.8rem;padding:.6rem 1.2rem;font:inherit;cursor:pointer}
.muted{color:#666;font-size:.9rem}.hp{position:absolute;left:-10000px}</style></head><body><h1>${esc(title)}</h1>${inner}</body></html>`;

  const unsubscribeUrl = (email) => `${config.publicUrl}/unsubscribe?t=${encodeURIComponent(sign(config.tokenSecret, { a: 'unsub', e: email }))}`;

  // ---- alerts ----------------------------------------------------------------------------------------------------
  async function deliver({ key, severity, title, text }) {
    const recipients = await resend.subscribers(config.segmentId);
    if (!recipients.length) return 0;
    const subject = `[${severity}] ${title}`;
    const emails = recipients.map((to) => {
      const unsub = unsubscribeUrl(to);
      return {
        from: config.mailFrom,
        to: [to],
        subject,
        text: `${text}\n\n--\n${config.siteName}. You get this because you subscribed. Unsubscribe: ${unsub}`,
        html: `<pre style="font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap">${esc(text)}</pre><p style="color:#666;font-size:12px">${esc(config.siteName)}. You get this because you subscribed. <a href="${esc(unsub)}">Unsubscribe</a></p>`,
        headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      };
    });
    const bucket = Math.floor(now() / 60_000);
    for (let i = 0; i < emails.length; i += 100) {
      await resend.sendBatch(emails.slice(i, i + 100), `${key}:${severity}:${bucket}:${i}`.slice(0, 256));
    }
    return emails.length;
  }

  /** Decides whether an alert goes out now, and sends it. */
  async function ingest(alert) {
    const prev = sentAt.get(alert.key);
    // An info alert only goes to people who were told about the problem it resolves.
    if (alert.severity === 'info' && !prev) return { sent: 0, reason: 'info without an earlier alert' };
    if (alert.severity !== 'info' && RANK[alert.severity] < RANK[config.minSeverity]) return { sent: 0, reason: 'below MIN_SEVERITY' };
    const due = !prev || alert.severity === 'info' || RANK[alert.severity] > RANK[prev.severity] || now() - prev.at >= REPEAT_MS[alert.severity];
    if (!due) return { sent: 0, reason: 'throttled' };
    const sent = await deliver(alert);
    if (alert.severity === 'info') sentAt.delete(alert.key);
    else sentAt.set(alert.key, { severity: alert.severity, at: now() });
    return { sent };
  }

  /** Called every minute: alerts for heartbeats that stopped. */
  async function checkHeartbeats() {
    for (const [name, hb] of heartbeats) {
      const quiet = now() - hb.last;
      if (quiet > hb.everyMs * 3 && !hb.alerted) {
        hb.alerted = true;
        await ingest({
          key: `heartbeat:${name}`,
          severity: 'critical',
          title: `${name} has stopped reporting`,
          text: `${name} has not reported for ${Math.round(quiet / 60_000)} minutes (expected every ${Math.round(hb.everyMs / 60_000)}). ` +
            'The scheduled job may be disabled, failing before it starts, or GitHub Actions may be down. Check the Actions tab.',
        }).catch((err) => log('heartbeat alert failed', err.message));
      }
    }
  }

  // ---- routes ----------------------------------------------------------------------------------------------------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain', cors(req));
    if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true });

    if (req.method === 'GET' && path === '/') {
      return send(res, 200, page(`${config.siteName}`, `<p>Get an email when something needs attention. Only warnings and critical alerts, at most a few a day, each with an unsubscribe link.</p>
<form method="post" action="${esc(config.publicUrl)}/api/subscribe"><label>Email<br><input type="email" name="email" required autocomplete="email"></label>
<label class="hp" aria-hidden="true">Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label><button type="submit">Subscribe</button></form>
<p class="muted">We send a confirmation link first. Your address is stored with our email provider (Resend) only to send these alerts.</p>`));
    }

    if (req.method === 'POST' && path === '/api/subscribe') {
      const headers = cors(req);
      const body = await readBody(req);
      const email = String(body.email ?? '').trim().toLowerCase();
      const answer = { ok: true, message: 'If the address is valid, a confirmation email is on its way.' };
      const wantsJson = String(req.headers.accept ?? '').includes('application/json');
      const reply = (status, b) => (wantsJson ? json(res, status, b, headers) : send(res, status, page(status === 200 ? 'Check your inbox' : 'Not sent', `<p>${esc(b.message)}</p>`), undefined, headers));
      if (body.website) return reply(200, answer); // honeypot: a bot filled the hidden field
      if (!EMAIL_RE.test(email) || email.length > 254) return reply(400, { ok: false, message: 'That does not look like an email address.' });
      if (limited(`ip:${clientIp(req)}`, 5, 3600e3) || limited(`email:${email}`, 3, 24 * 3600e3) || limited('global', 200, 3600e3)) {
        return reply(429, { ok: false, message: 'Too many requests. Try again later.' });
      }
      const token = sign(config.tokenSecret, { a: 'sub', e: email, x: now() + CONFIRM_TTL_MS });
      const link = `${config.publicUrl}/confirm?t=${encodeURIComponent(token)}`;
      await resend.sendOne({
        from: config.mailFrom,
        to: [email],
        subject: `Confirm your subscription to ${config.siteName}`,
        text: `Someone (hopefully you) asked to get ${config.siteName} by email.\n\nConfirm: ${link}\n\nThe link works for 48 hours. If this was not you, ignore this email and nothing happens.`,
        html: `<p>Someone (hopefully you) asked to get ${esc(config.siteName)} by email.</p><p><a href="${esc(link)}">Confirm the subscription</a></p><p style="color:#666">The link works for 48 hours. If this was not you, ignore this email and nothing happens.</p>`,
      });
      log('subscribe requested', tag(email));
      return reply(200, answer);
    }

    if (req.method === 'GET' && (path === '/confirm' || path === '/unsubscribe')) {
      const t = url.searchParams.get('t') ?? '';
      const action = path === '/confirm' ? 'sub' : 'unsub';
      const p = verify(config.tokenSecret, t, action, now());
      if (!p) return send(res, 400, page('Link not valid', '<p>This link is not valid or has expired. Subscribe again from the sign-up page.</p>'));
      const verb = action === 'sub' ? 'Confirm subscription' : 'Unsubscribe';
      return send(res, 200, page(verb, `<p>${esc(p.e)}</p><form method="post" action="${esc(config.publicUrl)}/api/${action === 'sub' ? 'confirm' : 'unsubscribe'}">
<input type="hidden" name="t" value="${esc(t)}"><button type="submit">${verb}</button></form>`));
    }

    if (req.method === 'POST' && (path === '/api/confirm' || path === '/api/unsubscribe')) {
      const body = await readBody(req);
      const t = body.t ?? url.searchParams.get('t') ?? ''; // one-click unsubscribe carries the token in the URL
      const action = path === '/api/confirm' ? 'sub' : 'unsub';
      const p = verify(config.tokenSecret, t, action, now());
      if (!p) return send(res, 400, page('Link not valid', '<p>This link is not valid or has expired.</p>'));
      if (action === 'sub') {
        await resend.subscribe(p.e, config.segmentId);
        log('subscribed', tag(p.e));
        return send(res, 200, page('Subscribed', `<p>Done. Alerts go to ${esc(p.e)}. Every email has an unsubscribe link.</p>`));
      }
      await resend.unsubscribe(p.e, config.segmentId);
      log('unsubscribed', tag(p.e));
      return send(res, 200, page('Unsubscribed', `<p>${esc(p.e)} gets no more alerts from ${esc(config.siteName)}.</p>`));
    }

    if (req.method === 'POST' && (path === '/api/alerts' || path === '/api/heartbeat')) {
      const auth = String(req.headers.authorization ?? '');
      if (!auth.startsWith('Bearer ') || !sameSecret(auth.slice(7), config.ingestToken)) return json(res, 401, { ok: false });
      const body = await readBody(req);
      if (path === '/api/heartbeat') {
        const name = String(body.name ?? '').slice(0, 80);
        const everySeconds = Number(body.everySeconds);
        if (!name || !Number.isFinite(everySeconds) || everySeconds < 60 || everySeconds > 7 * 86400) return json(res, 400, { ok: false, message: 'name and everySeconds (60..604800) required' });
        const prev = heartbeats.get(name);
        heartbeats.set(name, { everyMs: everySeconds * 1000, last: now(), alerted: false });
        if (prev?.alerted) {
          await ingest({ key: `heartbeat:${name}`, severity: 'info', title: `${name} is reporting again`, text: `${name} reported again after being quiet.` });
        }
        return json(res, 200, { ok: true });
      }
      const severity = String(body.severity ?? '');
      const title = String(body.title ?? '').slice(0, 200);
      const text = String(body.text ?? '').slice(0, 8000);
      const key = String(body.key ?? title).slice(0, 200);
      if (!SEVERITIES.includes(severity) || !title) return json(res, 400, { ok: false, message: 'severity (info|warn|critical) and title required' });
      const result = await ingest({ key, severity, title, text: text || title });
      return json(res, 202, { ok: true, ...result });
    }

    return send(res, 404, page('Not found', '<p>Nothing here.</p>'));
  }

  async function handler(req, res) {
    try {
      await handle(req, res);
    } catch (err) {
      log('request failed', req.method, new URL(req.url, 'http://x').pathname, err.status ?? 500, err.message);
      if (!res.headersSent) send(res, err.status ?? 502, page('Something went wrong', '<p>Please try again in a few minutes.</p>'));
    }
  }

  return { handler, checkHeartbeats, ingest, state: { sentAt, heartbeats } };
}
