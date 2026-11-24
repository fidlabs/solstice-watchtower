// FIP-0118's FIL pricing rule (Section 2.3, "FIL pricing rule"), recomputed from the Filecoin Pay fee auctions, and the
// judgments bin/fees.js alerts on. Pure: prints and parameters in, classifications and findings out.
//
// A print is one fee-auction claim, burnForFees(token, recipient, requested) with msg.value FIL burned:
//   { epoch, tx, pos, token, lot (raw token units, string), fil (attoFIL, string), claimer, ... }
// Its implied rate is the integer pair (lotUsd, fil), lotUsd = lot normalised to 18 decimals (atto-USD). Rates are
// compared by cross-multiplication and never divided, as the FIP's "Conversion arithmetic" requires.
import { quarterOf } from './chain.js'

export const HALVING_SECONDS = 3.5 * 24 * 3600 // Filecoin Pay Dutch.HALVING_INTERVAL; the price is x4 after each claim

export const lotUsd = (p, decimals) => BigInt(p.lot) * 10n ** BigInt(18 - decimals)
const pair = (p) => ({ usd: BigInt(p.usd), fil: BigInt(p.fil) })

// -1, 0, 1 as rate a is below, equal to, above rate b
export function compareRates(a, b) {
  const x = pair(a),
    y = pair(b)
  const l = x.usd * y.fil,
    r = y.usd * x.fil
  return l < r ? -1 : l > r ? 1 : 0
}

// |rate - ref| <= band * ref, in basis points: |usd*refFil - refUsd*fil| * 10000 <= band * refUsd * fil
export function withinBand(p, ref, bandBps) {
  const x = pair(p),
    y = pair(ref)
  const diff = x.usd * y.fil - y.usd * x.fil
  return (diff < 0n ? -diff : diff) * 10000n <= BigInt(bandBps) * y.usd * x.fil
}

// the middle of five rates, ordered by cross-multiplication
export const median = (prints) => [...prints].sort(compareRates)[Math.floor(prints.length / 2)]

export const usdPerFil = (p) => (p.fil === '0' ? Infinity : Number((BigInt(p.usd) * 10n ** 6n) / BigInt(p.fil)) / 1e6)

// The admitted lists and pricing parameters in force for quarter Q: the latest SRA event before Q's first epoch
// (the FIP: "the values in force for quarter Q are those of the most recent parameter event before Q's first epoch").
// The events come from the reader's own record, so this needs no second scan of the SRA.
export function paramsFor(cfg, records, Q) {
  let lists = null,
    pricing = null
  for (const r of records) {
    if (r.kind !== 'event' || r.source !== 'SRA' || quarterOf(cfg, r.epoch) >= Q) continue
    if (r.name === 'AdmittedListsUpdated') lists = r.fields
    if (r.name === 'PricingParamsUpdated') pricing = r.fields
  }
  return {
    stablecoins: new Set((lists?.stablecoins ?? []).map((a) => a.toLowerCase())),
    contracts: new Set((lists?.filecoinPayContracts ?? []).map((a) => a.toLowerCase())),
    // MIN_LOT(1) = MIN_LOT_FLOOR. From quarter 2 MIN_LOT also depends on BoundVolume(Q-1) / N(Q-1); that is not
    // computed yet (TODO before Q1 binds, 2027-01-28), so the floor is used and later quarters are marked provisional.
    minLot: pricing ? BigInt(pricing.minLotFloor) : null,
    priceBand: pricing ? Number(pricing.priceBand) : null,
    provisional: Q > 1,
  }
}

// Runs one print through the rule and updates the pricing state { seed: [...], reference: print|null }.
// Returns the print's status:
//   'not admitted'  contract or token not on the admitted lists in force
//   'dust'          lot below MIN_LOT
//   'seed'          one of the first five prints that meet everything but the band; the fifth sets the reference
//   'qualifies'     within PRICE_BAND of the reference; it becomes the new reference
//   'outside band'  more than PRICE_BAND from the reference; it prices nothing
export function classify(state, p, params) {
  if (!params.contracts.has(p.contract) || !params.stablecoins.has(p.token)) return 'not admitted'
  if (params.minLot === null || BigInt(p.usd) < params.minLot) return 'dust'
  if (!state.reference) {
    state.seed.push(p)
    if (state.seed.length === 5) state.reference = median(state.seed)
    return 'seed'
  }
  if (!withinBand(p, state.reference, params.priceBand)) return 'outside band'
  state.reference = p
  return 'qualifies'
}

// The auction price now, in attoFIL, from auctionInfo(token) = (startPrice, startTime): halves every 3.5 days.
export function auctionPrice({ startPrice, startTime }, nowSeconds) {
  const elapsed = Math.max(0, nowSeconds - Number(startTime))
  return BigInt(startPrice) === 0n ? 0n : BigInt(Math.floor(Number(startPrice) / 2 ** (elapsed / HALVING_SECONDS)))
}

const fmtUsd = (x) =>
  !Number.isFinite(x) ? '∞' : x >= 100 ? '$' + Math.round(x).toLocaleString('en-US') : '$' + x.toFixed(x >= 1 ? 2 : 4)
const fmtFil = (atto) => (Number(BigInt(atto)) / 1e18).toPrecision(4) + ' FIL'
export const fmt = { usd: fmtUsd, fil: fmtFil }

// One line per claim, for Slack and the log.
export function claimLine(p, symbol) {
  const flags = [
    p.partial && 'took part of the pot',
    p.overpaid && 'paid above the auction price',
    p.unknownClaimer && 'new claimer',
  ]
    .filter(Boolean)
    .join(', ')
  return (
    `fee-auction claim ${symbol}: ${fmtUsd(Number(BigInt(p.usd)) / 1e18)} for ${fmtFil(p.fil)} = ${fmtUsd(usdPerFil(p))}/FIL · ${p.status}` +
    (p.provisional ? ' (provisional)' : '') +
    (flags ? ` · ${flags}` : '') +
    ` · claimer ${p.claimer}`
  )
}

// Standing findings from the live auction state, re-checked every run. `tokens` is one entry per admitted stablecoin:
//   { symbol, address, potUsd (atto-USD), price (attoFIL), lastPrint }
// and `reference` the current band reference (or null). Each finding stays raised while its condition holds.
export function standingFindings(cfg, { tokens, reference }) {
  const w = cfg.feeWatch
  const out = []
  const [lo, hi] = w.filUsdSane
  if (reference) {
    const r = usdPerFil(reference)
    if (r < lo || r > hi)
      out.push({
        key: 'fees:reference',
        severity: 'warn',
        repeatHours: w.statusRepeatHours,
        title: `the FIP-0118 FIL price reference is ${fmtUsd(r)}/FIL, outside ${fmtUsd(lo)} to ${fmtUsd(hi)}`,
        text:
          `Any FIL settled on a registered payer/operator pair is valued at this rate. The reference is the last qualifying ` +
          `fee-auction print (${reference.tx}, epoch ${reference.epoch}); a print qualifies only within PRICE_BAND of it, ` +
          `so correct prints are rejected and the reference cannot return on its own.`,
      })
  }
  for (const t of tokens) {
    if (t.potUsd < BigInt(Math.round(w.potAlertUsd * 1e6)) * 10n ** 12n) continue
    const whole = { usd: t.potUsd.toString(), fil: t.price.toString() }
    out.push({
      key: `fees:pot:${t.symbol}`,
      severity: 'warn',
      repeatHours: w.statusRepeatHours,
      title: `the ${t.symbol} fee pot holds ${fmtUsd(Number(t.potUsd) / 1e18)}, claimable for ${fmtFil(t.price)}`,
      text:
        `Anyone can take the whole pot by calling burnForFees on ${w.filecoinPay} with at least the auction price; taking it all ` +
        `would print ${fmtUsd(usdPerFil(whole))}/FIL. A buyer chooses the lot and the FIL paid, so can print any rate up to that.`,
    })
  }
  const last = tokens.filter((t) => t.lastPrint).map((t) => ({ t, r: usdPerFil(t.lastPrint) }))
  if (last.length >= 2) {
    last.sort((a, b) => a.r - b.r)
    const low = last[0],
      high = last[last.length - 1]
    if (high.r / low.r > w.divergenceRatio)
      out.push({
        key: 'fees:divergence',
        severity: 'warn',
        repeatHours: w.statusRepeatHours,
        title: `the fee auctions disagree on the FIL price: ${high.t.symbol} ${fmtUsd(high.r)}/FIL, ${low.t.symbol} ${fmtUsd(low.r)}/FIL`,
        text: `The last claim of each admitted stablecoin implies these rates, ${Math.round(high.r / low.r).toLocaleString('en-US')}x apart. At least one auction is far from market.`,
      })
  }
  return out
}
