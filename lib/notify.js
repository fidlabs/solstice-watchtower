// One Slack message per reader run that found something new. The webhook URL comes from the environment
// (SLACK_WEBHOOK, a GitHub secret); without it nothing is sent. A failed post never fails the run.
// Slack accepts {"text": "..."} for both an Incoming WebHook and a Workflow Builder webhook with a `text` variable.
// The page people are sent to. Set WATCHTOWER_PAGE_URL once it is hosted (e.g. https://watchtower.fidl.tech/).
const PAGE = process.env.WATCHTOWER_PAGE_URL || 'https://solsticewatchtower.eth.limo/'
const MAX_LINES = 40

// A taskId is a 66-character hash that tells a reader nothing: the Slack line keeps its first 10 characters (the record keeps it whole).
const flat = (v) => (v === null || v === undefined ? '–' : Array.isArray(v) ? v.map(flat).join(', ') : typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}: ${k === 'taskId' ? String(x).slice(0, 10) + '…' : flat(x)}`).join(', ') : String(v))

// The records worth a message: events, messages, gaps, and the two reads that judge something.
export const notable = (r) => r.kind !== 'read' || r.name === 'queued write outcome' || r.name === 'claim check'

// Long field lists are cut at a separator, never inside a value: a half address is worse than none.
const MAX_FIELDS = 400
const cut = (t) => { if (t.length <= MAX_FIELDS) return t; const i = t.lastIndexOf(', ', MAX_FIELDS); return t.slice(0, i > 0 ? i : MAX_FIELDS) + ' …' }

// Same explorer as the page's "message" column; a network without one gets no link.
const EXPLORER = { calibnet: 'https://calibration.filfox.info/en/message/', mainnet: 'https://filfox.info/en/message/' }

export function slackLine(r, network) {
  const result = r.kind === 'message' ? (r.ok ? 'ok' : `FAILED ${r.error ?? ''}`) : r.name === 'claim check' ? (r.fields.matches ? 'matches' : 'DOES NOT MATCH') : r.kind === 'gap' ? 'NOT READ' : ''
  const who = r.via ? ` via ${r.via}` : ''
  const id = r.tx ?? r.msgCid
  const link = id && EXPLORER[network] ? ` · <${EXPLORER[network]}${id}|message>` : ''
  return `• ${r.time.slice(11, 16)} UTC · ${r.source} ${r.kind} \`${r.name}\`${who} ${result} · ${cut(flat(r.fields))}${link}`
}

export function slackText(records, cfg, from, to) {
  const lines = records.filter(notable).map((r) => slackLine(r, cfg.network))
  if (!lines.length) return null
  const more = lines.length > MAX_LINES ? `\n… and ${lines.length - MAX_LINES} more, see the page` : ''
  const view = cfg.network === 'mainnet' ? PAGE : `${PAGE}?data=${cfg.network}`
  return `*${cfg.network}* · epochs ${from} to ${to} · ${lines.length} new\n${lines.slice(0, MAX_LINES).join('\n')}${more}\n${view}`
}

// A post is tried three times, then kept in status.slackPending and sent first at the next run: a message is delayed
// by a Slack outage, never dropped (the record had already advanced; diagnostic review PF-12, 2026-10-08).
const TRIES = 3, MAX_PENDING = 20
const pauseMs = () => Number(process.env.SLACK_RETRY_MS ?? 10_000) // the env override is for the tests
async function post(url, text) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
      if (res.ok) return true
      console.error(`slack: ${res.status} ${(await res.text()).slice(0, 200)}`)
    } catch (err) {
      console.error(`slack: ${err.message}`) // never fail the run over a notification
    }
    if (i === TRIES) return false
    await new Promise((r) => setTimeout(r, pauseMs()))
  }
}

export async function notify(records, cfg, from, to, status = {}) {
  const url = process.env.SLACK_WEBHOOK
  if (!url || cfg.notify === false) return
  const text = slackText(records, cfg, from, to)
  const queue = [...(status.slackPending ?? []), ...(text ? [text] : [])]
  const left = []
  for (const t of queue) {
    if (left.length || !(await post(url, t))) left.push(t) // keep the order: nothing after a failed one is sent
  }
  status.slackPending = left.slice(-MAX_PENDING)
  if (left.length) console.error(`slack: ${left.length} message(s) kept for the next run`)
}

// The subscriber email service (alerts-service/), when ALERT_SERVICE_URL and ALERT_SERVICE_TOKEN are set. It throttles
// repeats per key, mails everyone who signed up, and raises its own alarm when heartbeats stop. Best-effort: never throws.
async function service(path, body) {
  const base = process.env.ALERT_SERVICE_URL?.replace(/\/+$/, ''), token = process.env.ALERT_SERVICE_TOKEN
  if (!base || !token) return false
  try {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
    if (!res.ok) console.error(`alert service: ${res.status} on ${path}`)
    return res.ok
  } catch (err) {
    console.error(`alert service: ${err.message}`)
    return false
  }
}

// A judgment the backup senders or the absence check make: something a person must look at. Goes to Slack (one line)
// and to the email subscribers, unless the network is opted out. Never throws: a failed notification must not hide the
// problem it reports.
const ICON = { info: 'ℹ️', warn: '⚠️', critical: '🚨' }
export async function alert({ severity = 'warn', title, text, key }, cfg) {
  const line = `${ICON[severity] ?? ''} *${cfg.network}* · ${title}${text ? `\n${text}` : ''}`
  console.error(`[ALERT ${severity}] ${title}${text ? ` -- ${text}` : ''}`)
  if (cfg.notify === false) return
  const url = process.env.SLACK_WEBHOOK
  if (url) { try { await post(url, line) } catch (err) { console.error(`slack: ${err.message}`) } }
  await service('/api/alerts', { key: `${cfg.network}:${key ?? title}`, severity, title: `${cfg.network}: ${title}`, text: text || title })
}

export async function heartbeat(cfg, name, everySeconds) {
  if (cfg.notify === false) return false
  return service('/api/heartbeat', { name, everySeconds })
}

// The records worth an email, out of everything Slack gets: what failed, what changed who controls the contracts, what
// the reader could not see, and a Claim whose payout does not match the balance change.
const CONTROL = new Set(['Upgraded', 'OwnerAdded', 'OwnerRemoved', 'OwnerReplaced'])
export function emailWorthy(r) {
  if (r.kind === 'message' && r.ok === false && ['SRA', 'SWA', 'f02'].includes(r.source)) return { severity: 'warn', title: `${r.source} message failed: ${r.name}${r.error ? ` (${r.error})` : ''}` }
  if (r.kind === 'event' && CONTROL.has(r.name)) return { severity: 'warn', title: `${r.source} ${r.name}` }
  if (r.kind === 'gap') return { severity: 'warn', title: `the reader could not read epochs ${r.fields?.fromEpoch} to ${r.fields?.toEpoch}` }
  if (r.name === 'claim check' && r.fields?.matches === false) return { severity: 'warn', title: 'a Claim payout does not match the balance change' }
  return null
}

// Slack already gets every record through notify(); this sends only the email.
export async function emailRecords(records, cfg) {
  if (cfg.notify === false) return
  const view = cfg.network === 'mainnet' ? PAGE : `${PAGE}?data=${cfg.network}`
  for (const r of records) {
    const e = emailWorthy(r)
    if (!e) continue
    await service('/api/alerts', { key: `${cfg.network}:${r.name}:${r.tx ?? r.msgCid ?? r.epoch}`, severity: e.severity, title: `${cfg.network}: ${e.title}`, text: `${slackLine(r, cfg.network).replace(/^• /, '')}\n\nThe record: ${view}` })
  }
}
