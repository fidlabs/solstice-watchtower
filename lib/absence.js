// Absence: the one judgment the record alone cannot make. "Nothing landed" is silent in a log of what landed, so this
// compares chain state with the schedule and names what is overdue. Pure: chain state in, findings out.
import { bindingEpoch, dueCalls } from './chain.js'

const H = (cfg, hours) => Math.round(hours * 3600 / cfg.epochSeconds)

// submitShares(q) must land before quarter q+1 binds, or quarter q's share map is lost for good (NotLatestQuarter).
//   warn      absenceAlertHours (default 6) after binding
//   critical  once the backup cranker's own delay plus that has passed too, or inside the last 7 days of the window
// quarterlyGateCheck has no deadline: warn gateAlertHours (default 48) after its quarter binds.
export function absenceFindings(cfg, chainState) {
  const { head } = chainState
  const { due } = dueCalls(cfg, chainState)
  const warnAfter = H(cfg, cfg.absenceAlertHours ?? 6)
  const out = []
  for (const call of due) {
    const overdue = head - call.since
    if (call.name === 'submitShares') {
      if (overdue < warnAfter) continue
      const q = Number(call.args[0])
      const deadline = bindingEpoch(cfg, q + 1)
      const left = deadline - head
      const critical = overdue >= (cfg.crankDelayEpochs ?? 0) + warnAfter || left <= H(cfg, 7 * 24)
      out.push({
        key: call.key,
        severity: critical ? 'critical' : 'warn',
        title: `submitShares(${q}) has not landed`,
        text: `Quarter ${q} bound at epoch ${call.since}, ${hours(cfg, overdue)} ago, and the SRA still reports lastSubmittedQuarter ${chainState.lastSubmitted}. ` +
          `Its window closes at epoch ${deadline} (${hours(cfg, left)} from now); after that quarter ${q}'s share map is lost for good.`,
      })
    } else {
      if (overdue < H(cfg, cfg.gateAlertHours ?? 48)) continue
      out.push({
        key: call.key,
        severity: 'warn',
        title: `${call.key} has not landed`,
        text: `Its quarter bound at epoch ${call.since}, ${hours(cfg, overdue)} ago. No deadline, but the w2 weight step waits for it.`,
      })
    }
  }
  return out
}

const hours = (cfg, epochs) => {
  const h = epochs * cfg.epochSeconds / 3600
  return h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h.toFixed(1)} h`
}

// Which findings to send now, given what was sent before: new ones, escalations, and reminders (critical every 6 hours,
// warn every 24), plus a "resolved" line for each finding that went away. Returns the messages and the new sent-state.
export function throttle(findings, sent = {}, nowMs = Date.now()) {
  const REPEAT_MS = { critical: 6 * 3600e3, warn: 24 * 3600e3 }
  const RANK = { warn: 1, critical: 2 }
  const send = [], next = {}
  for (const f of findings) {
    const prev = sent[f.key]
    const due = !prev || RANK[f.severity] > RANK[prev.severity] || nowMs - Date.parse(prev.at) >= REPEAT_MS[f.severity]
    if (due) send.push(f)
    next[f.key] = due ? { severity: f.severity, at: new Date(nowMs).toISOString() } : prev
  }
  for (const key of Object.keys(sent)) {
    if (!findings.some((f) => f.key === key)) send.push({ key, severity: 'info', title: `resolved: ${key} has landed`, text: '' })
  }
  return { send, sent: next }
}
