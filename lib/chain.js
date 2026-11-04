// JSON-RPC calls to a Filecoin node, plus the two clock rules: epoch -> time and epoch -> quarter.

export function makeRpc(url) {
  let id = 0
  return async function rpc(method, params = []) {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        })
        const body = await res.json()
        if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { rpc: body.error })
        return body.result
      } catch (err) {
        if (err.rpc || attempt === 3) throw err // the node answered with an error: retrying will not help
        await new Promise((r) => setTimeout(r, 1000 * attempt))
      }
    }
  }
}

export const toHex = (n) => '0x' + BigInt(n).toString(16)

export const epochToTime = (cfg, epoch) =>
  new Date((cfg.genesisTimestamp + epoch * cfg.epochSeconds) * 1000).toISOString()

// Quarter numbers are FIP-0118 §2.2's, as in the FIP, the fpv-indexer and the records already written:
// quarter Q is [Start(Q), Start(Q+1)) with Start(Q) = ACTIVATION_EPOCH + (Q-1) * EPOCHS_PER_QUARTER. 0 means before
// activation. Quarter Q's activity settles inside quarter Q+1 (SRA: "Quarter anchor E = FIP-0118 Start(q+1), where
// quarter q's cycle opens"): posting, verification, then binding, after which submitShares(Q) and the gate check for Q
// can run. The SRA's calls and events carry the same Q; only its internal index (_quarterOf) counts from 0.
export function quarterOf(cfg, epoch) {
  if (!cfg.activationEpoch || epoch < cfg.activationEpoch) return 0
  return Math.floor((epoch - cfg.activationEpoch) / cfg.epochsPerQuarter) + 1
}

// First epoch of quarter Q (FIP-0118 Start(Q)). The SRA's quarterStart(q) is Start(q+1).
export const quarterStart = (cfg, Q) => cfg.activationEpoch + (Q - 1) * cfg.epochsPerQuarter

// The epoch at which quarter Q binds, inside quarter Q+1: submitShares(Q) and the gate check for Q become callable.
export const bindingEpoch = (cfg, Q) => quarterStart(cfg, Q + 1) + cfg.postPeriod + cfg.verificationWindow

export function dueCalls(cfg, { head, lastSubmitted, lastChecked, steps }) {
  const Q = quarterOf(cfg, head)
  if (Q === 0) return { quarter: 0, latestBound: null, due: [] }
  const latestBound = head >= bindingEpoch(cfg, Q - 1) ? Q - 1 : Q - 2 // the cycle running now settles quarter Q-1
  const due = []
  if (latestBound >= 1 && lastSubmitted < latestBound) due.push({ name: 'submitShares', args: [BigInt(latestBound)], key: `submitShares(${latestBound})`, since: bindingEpoch(cfg, latestBound) })
  if (steps < 8 && head >= bindingEpoch(cfg, lastChecked + 1)) due.push({ name: 'quarterlyGateCheck', args: [], key: `quarterlyGateCheck(${lastChecked + 1})`, since: bindingEpoch(cfg, lastChecked + 1) })
  return { quarter: Q, latestBound, due }
}
