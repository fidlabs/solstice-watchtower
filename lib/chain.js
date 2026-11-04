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

// Quarter numbers follow the SRA, which is what executes (ServiceRewardsActor._quarterOf):
// quarter q is [ACTIVATION_EPOCH + q * EPOCHS_PER_QUARTER, ACTIVATION_EPOCH + (q+1) * EPOCHS_PER_QUARTER).
// Quarter 0 is the span from activation to the first posting window. Quarter q's cycle (posting,
// verification, binding, submitShares(q)) runs at the start of quarter q and settles the activity of
// quarter q-1's span -- which FIP-0118 §2.2 calls "Q" (Start(Q) = ACTIVATION_EPOCH + (Q-1) * EPOCHS_PER_QUARTER).
// null means before activation (or no activation epoch configured).
export function quarterOf(cfg, epoch) {
  if (!cfg.activationEpoch || epoch < cfg.activationEpoch) return null
  return Math.floor((epoch - cfg.activationEpoch) / cfg.epochsPerQuarter)
}

// First epoch of quarter q, as the SRA's quarterStart(q).
export const quarterStart = (cfg, q) => cfg.activationEpoch + q * cfg.epochsPerQuarter

// The epoch at which quarter q binds: submitShares(q) and the gate check for q become callable.
export const bindingEpoch = (cfg, q) => quarterStart(cfg, q) + cfg.postPeriod + cfg.verificationWindow

// The calls the backup cranker may send, from chain state alone. `since` is the epoch the call became possible (its
// quarter's binding); the caller adds its delay. submitShares accepts only the latest bound quarter (an older one reverts
// NotLatestQuarter), and quarter q binds inside quarter q. Quarter 0 is never submittable.
export function dueCalls(cfg, { head, lastSubmitted, lastChecked, steps }) {
  const q = quarterOf(cfg, head)
  if (q === null) return { quarter: null, latestBound: null, due: [] }
  const latestBound = head >= bindingEpoch(cfg, q) ? q : q - 1
  const due = []
  if (latestBound >= 1 && lastSubmitted < latestBound) due.push({ name: 'submitShares', args: [BigInt(latestBound)], key: `submitShares(${latestBound})`, since: bindingEpoch(cfg, latestBound) })
  if (steps < 8 && head >= bindingEpoch(cfg, lastChecked + 1)) due.push({ name: 'quarterlyGateCheck', args: [], key: `quarterlyGateCheck(${lastChecked + 1})`, since: bindingEpoch(cfg, lastChecked + 1) })
  return { quarter: q, latestBound, due }
}
