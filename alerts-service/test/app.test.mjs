import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { createResend, ResendError } from '../src/resend.mjs';
import { sign, verify } from '../src/tokens.mjs';

const ENV = {
  PUBLIC_URL: 'https://alerts.example.test',
  SITE_NAME: 'Test alerts',
  RESEND_API_KEY: 're_test',
  RESEND_SEGMENT_ID: 'seg_1',
  MAIL_FROM: 'Alerts <alerts@example.test>',
  TOKEN_SECRET: 'x'.repeat(32),
  INGEST_TOKEN: 'i'.repeat(40),
  ALLOWED_ORIGINS: 'https://watch.example.test',
  CLIENT_IP_HEADER: 'x-test-ip',
};

function fakeResend() {
  const f = { members: new Set(), sent: [], batches: [] };
  f.subscribe = async (email) => void f.members.add(email);
  f.unsubscribe = async (email) => void f.members.delete(email);
  f.subscribers = async () => [...f.members];
  f.sendOne = async (email) => void f.sent.push(email);
  f.sendBatch = async (emails, key) => void f.batches.push({ emails, key });
  return f;
}

let server, base, resend, app, clock;
const config = loadConfig(ENV);
const logs = [];

before(async () => {
  server = createServer((req, res) => app.handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  resend = fakeResend();
  clock = { t: Date.parse('2027-01-28T20:00:00Z') };
  logs.length = 0;
  app = createApp({ config, resend, now: () => clock.t, log: (...a) => logs.push(a.join(' ')) });
});

const form = (path, fields, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-ip': '10.0.0.1', ...headers }, body: new URLSearchParams(fields) });
const alert = (body, token = ENV.INGEST_TOKEN) =>
  fetch(base + '/api/alerts', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const linkIn = (text, path) => new URL(text.match(new RegExp(`https://alerts\\.example\\.test${path}\\?t=[^\\s"]+`))[0]);

describe('config', () => {
  it('refuses short secrets and a missing sender', () => {
    assert.throws(() => loadConfig({ ...ENV, TOKEN_SECRET: 'short' }), /TOKEN_SECRET must be at least 32/);
    assert.throws(() => loadConfig({ ...ENV, INGEST_TOKEN: '' }), /INGEST_TOKEN is not set/);
    assert.throws(() => loadConfig({ ...ENV, MAIL_FROM: '' }), /MAIL_FROM is not set/);
    assert.throws(() => loadConfig({ ...ENV, MIN_SEVERITY: 'loud' }), /MIN_SEVERITY/);
  });
});

describe('tokens', () => {
  it('verifies its own token for the right action only, and expires it', () => {
    const t = sign('s'.repeat(32), { a: 'sub', e: 'a@b.co', x: 1000 });
    assert.equal(verify('s'.repeat(32), t, 'sub', 999).e, 'a@b.co');
    assert.equal(verify('s'.repeat(32), t, 'unsub', 999), null);
    assert.equal(verify('s'.repeat(32), t, 'sub', 1001), null);
    assert.equal(verify('o'.repeat(32), t, 'sub', 999), null);
    assert.equal(verify('s'.repeat(32), t.slice(0, -2) + 'AA', 'sub', 999), null);
  });
});

describe('sign-up: double opt-in', () => {
  it('sends a confirmation link, and only the POST behind it subscribes', async () => {
    const res = await form('/api/subscribe', { email: 'Ops@Example.org' });
    assert.equal(res.status, 200);
    assert.equal(resend.sent.length, 1);
    assert.equal(resend.members.size, 0, 'nothing subscribed before confirmation');
    const link = linkIn(resend.sent[0].text, '/confirm');

    // A mail scanner opening the link only gets a page with a button.
    const page = await fetch(base + link.pathname + link.search);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Confirm subscription/);
    assert.equal(resend.members.size, 0);

    const done = await form('/api/confirm', { t: link.searchParams.get('t') });
    assert.equal(done.status, 200);
    assert.deepEqual([...resend.members], ['ops@example.org']);
  });

  it('a confirmation link expires after 48 hours', async () => {
    await form('/api/subscribe', { email: 'late@example.org' });
    const t = linkIn(resend.sent[0].text, '/confirm').searchParams.get('t');
    clock.t += 49 * 3600e3;
    assert.equal((await form('/api/confirm', { t })).status, 400);
    assert.equal(resend.members.size, 0);
  });

  it('the honeypot field gets the same answer and no email', async () => {
    const res = await form('/api/subscribe', { email: 'bot@example.org', website: 'http://spam' });
    assert.equal(res.status, 200);
    assert.equal(resend.sent.length, 0);
  });

  it('rejects a malformed address and rate-limits by client address', async () => {
    assert.equal((await form('/api/subscribe', { email: 'not-an-email' })).status, 400);
    for (let i = 0; i < 5; i++) assert.equal((await form('/api/subscribe', { email: `u${i}@example.org` })).status, 200);
    assert.equal((await form('/api/subscribe', { email: 'u9@example.org' })).status, 429);
    assert.equal((await form('/api/subscribe', { email: 'u9@example.org' }, { 'x-test-ip': '10.0.0.2' })).status, 200);
  });

  it('allows the configured origin to post the form, and no other', async () => {
    const ok = await form('/api/subscribe', { email: 'x@example.org' }, { origin: 'https://watch.example.test', accept: 'application/json' });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://watch.example.test');
    assert.equal((await ok.json()).ok, true);
    const other = await form('/api/subscribe', { email: 'y@example.org' }, { origin: 'https://evil.example', 'x-test-ip': '10.0.0.3' });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });

  it('never writes an address to the log', async () => {
    await form('/api/subscribe', { email: 'private@example.org' });
    await form('/api/confirm', { t: linkIn(resend.sent[0].text, '/confirm').searchParams.get('t') });
    assert.ok(logs.length >= 2);
    assert.ok(logs.every((l) => !l.includes('private@example.org')));
  });
});

describe('alerts', () => {
  beforeEach(() => {
    resend.members.add('a@example.org');
    resend.members.add('b@example.org');
  });

  it('refuses a missing or wrong ingest token', async () => {
    assert.equal((await alert({ severity: 'warn', title: 't' }, 'nope')).status, 401);
    assert.equal(resend.batches.length, 0);
  });

  it('sends one email per subscriber, each with its own unsubscribe link and one-click headers', async () => {
    const res = await alert({ key: 'k', severity: 'critical', title: 'submitShares(1) has not landed', text: 'details' });
    assert.equal(res.status, 202);
    assert.equal((await res.json()).sent, 2);
    const [batch] = resend.batches;
    assert.deepEqual(batch.emails.map((e) => e.to[0]).sort(), ['a@example.org', 'b@example.org']);
    for (const e of batch.emails) {
      assert.equal(e.subject, '[critical] submitShares(1) has not landed');
      const unsub = linkIn(e.text, '/unsubscribe');
      assert.equal(verify(ENV.TOKEN_SECRET, unsub.searchParams.get('t'), 'unsub').e, e.to[0]);
      assert.equal(e.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
      assert.match(e.headers['List-Unsubscribe'], /^<https:\/\/alerts\.example\.test\/unsubscribe\?t=/);
    }
  });

  it('throttles repeats per key, sends escalations at once, and repeats after the interval', async () => {
    await alert({ key: 'q1', severity: 'warn', title: 't' });
    await alert({ key: 'q1', severity: 'warn', title: 't' });
    assert.equal(resend.batches.length, 1, 'a job running every 15 minutes must not mail every 15 minutes');
    await alert({ key: 'q1', severity: 'critical', title: 't' });
    assert.equal(resend.batches.length, 2, 'escalation goes out at once');
    clock.t += 59 * 60e3;
    await alert({ key: 'q1', severity: 'critical', title: 't' });
    assert.equal(resend.batches.length, 2);
    clock.t += 2 * 60e3;
    await alert({ key: 'q1', severity: 'critical', title: 't' });
    assert.equal(resend.batches.length, 3, 'critical repeats hourly');
  });

  it('drops info unless it resolves an alert people already got', async () => {
    await alert({ key: 'q2', severity: 'info', title: 'resolved' });
    assert.equal(resend.batches.length, 0);
    await alert({ key: 'q2', severity: 'warn', title: 'overdue' });
    await alert({ key: 'q2', severity: 'info', title: 'resolved' });
    assert.equal(resend.batches.length, 2);
  });

  it('one-click unsubscribe from a mail client removes the address', async () => {
    await alert({ key: 'k', severity: 'warn', title: 't' });
    const email = resend.batches[0].emails.find((e) => e.to[0] === 'a@example.org');
    const unsub = linkIn(email.text, '/unsubscribe');
    const res = await fetch(`${base}/api/unsubscribe${unsub.search}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(res.status, 200);
    assert.deepEqual([...resend.members], ['b@example.org']);
  });
});

describe('heartbeats', () => {
  const beat = (body) => fetch(base + '/api/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ENV.INGEST_TOKEN}` }, body: JSON.stringify(body) });

  it('alerts once when a job stops reporting, and again when it is back', async () => {
    resend.members.add('a@example.org');
    assert.equal((await beat({ name: 'watchtower reader', everySeconds: 600 })).status, 200);
    clock.t += 25 * 60e3;
    await app.checkHeartbeats();
    assert.equal(resend.batches.length, 0, 'within 3x the interval: quiet');
    clock.t += 10 * 60e3;
    await app.checkHeartbeats();
    await app.checkHeartbeats();
    assert.equal(resend.batches.length, 1);
    assert.match(resend.batches[0].emails[0].subject, /\[critical\] watchtower reader has stopped reporting/);
    await beat({ name: 'watchtower reader', everySeconds: 600 });
    assert.equal(resend.batches.length, 2);
    assert.match(resend.batches[1].emails[0].subject, /\[info\] watchtower reader is reporting again/);
  });

  it('rejects nonsense intervals', async () => {
    assert.equal((await beat({ name: 'x', everySeconds: 5 })).status, 400);
  });
});

describe('Resend client', () => {
  it('adds an existing contact to the segment when create says it exists, and pages through subscribers', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(`${init.method} ${url.replace('https://api.resend.com', '')}`);
      if (init.method === 'POST' && url.endsWith('/contacts')) return new Response(JSON.stringify({ message: 'exists' }), { status: 409 });
      if (init.method === 'GET' && !url.includes('after=')) return Response.json({ has_more: true, data: [{ id: 'c1', email: 'a@x.co', unsubscribed: false }, { id: 'c2', email: 'b@x.co', unsubscribed: true }] });
      if (init.method === 'GET') return Response.json({ has_more: false, data: [{ id: 'c3', email: 'c@x.co', unsubscribed: false }] });
      return Response.json({});
    };
    const r = createResend({ apiKey: 'k', fetchImpl });
    await r.subscribe('a@x.co', 'seg');
    assert.deepEqual(calls.slice(0, 2), ['POST /contacts', 'POST /contacts/a%40x.co/segments/seg']);
    assert.deepEqual(await r.subscribers('seg'), ['a@x.co', 'c@x.co']);
    assert.ok(calls.some((c) => c.includes('after=c2')));
  });

  it('surfaces other errors, and treats unsubscribing a non-member as done', async () => {
    const r = createResend({ apiKey: 'k', fetchImpl: async () => new Response('{"message":"nope"}', { status: 404 }) });
    await r.unsubscribe('a@x.co', 'seg');
    const bad = createResend({ apiKey: 'k', fetchImpl: async () => new Response('{"message":"bad"}', { status: 500 }) });
    await assert.rejects(() => bad.sendOne({}), ResendError);
  });
});
