// The FIP-0118 FIL pricing rule (lib/fees.js). Unlike watchtower.test.js, the first test uses CHAIN DATA: the eleven
// mainnet quarter-1 fee-auction claims up to 2026-11-19 (tests/fees-q1.json, exact lots and attoFIL, decoded from the
// transactions), whose result the fpv-indexer published: seed median $1,928.71, then $1,537 and $1,498 qualify.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  classify,
  compareRates,
  withinBand,
  median,
  paramsFor,
  auctionPrice,
  usdPerFil,
  standingFindings,
  HALVING_SECONDS,
} from '../lib/fees.js'
import { throttle } from '../lib/absence.js'
import { emailWorthy } from '../lib/notify.js'

const cfg = { activationEpoch: 6470280, epochsPerQuarter: 262974 }
const USDFC = '0x80b98d3aa09ffff255c3ba4a241111ff1262f045',
  AXL = '0xeb466342c4d449bc9f53a865d5cb90586f405215',
  FP = '0x23b1e018f08bb982348b15a86ee926eebf7f4daa'
const records = [
  {
    kind: 'event',
    source: 'SRA',
    epoch: 6459253,
    name: 'AdmittedListsUpdated',
    fields: { stablecoins: [USDFC, AXL], filecoinPayContracts: [FP] },
  },
  {
    kind: 'event',
    source: 'SRA',
    epoch: 6459257,
    name: 'PricingParamsUpdated',
    fields: {
      minLotFloor: '500000000000000000',
      minLotAlphaNum: '1',
      minLotAlphaDen: '400',
      priceBand: '3000',
      registrationCutoff: '20160',
    },
  },
]
const p = (usd, fil, extra = {}) => ({ usd: String(usd), fil: String(fil), contract: FP, token: AXL, ...extra })

test('mainnet quarter 1: the rule reproduces the indexer (seed $1,928.71, then $1,537 and $1,498 qualify)', () => {
  const prints = JSON.parse(readFileSync(new URL('./fees-q1.json', import.meta.url)))
  const state = { seed: [], reference: null }
  const params = paramsFor(cfg, records, 1)
  const got = prints.map((x) => [x.epoch, classify(state, x, params), Math.round(usdPerFil(x))])
  assert.deepEqual(got, [
    [6477570, 'seed', 1],
    [6479540, 'seed', 6084],
    [6499621, 'seed', 6030],
    [6499667, 'seed', 1],
    [6511207, 'seed', 1929],
    [6516251, 'outside band', 1],
    [6519871, 'outside band', 677],
    [6540100, 'qualifies', 1537],
    [6540338, 'outside band', 1],
    [6557313, 'outside band', 2],
    [6560080, 'qualifies', 1498],
  ])
  assert.equal(state.reference.epoch, 6560080)
})

test('rates compare by cross-multiplication; the band is inclusive; the median is the middle of five', () => {
  assert.equal(compareRates(p(2, 1), p(4, 2)), 0)
  assert.equal(compareRates(p(1, 1), p(3, 2)), -1)
  const ref = p(100, 1)
  assert.equal(withinBand(p(130, 1), ref, 3000), true) // exactly +30%
  assert.equal(withinBand(p(70, 1), ref, 3000), true) // exactly -30%
  assert.equal(withinBand(p(131, 1), ref, 3000), false)
  assert.equal(withinBand(p(69, 1), ref, 3000), false)
  assert.equal(median([p(5, 1), p(1, 1), p(4, 1), p(2, 1), p(3, 1)]).usd, '3')
})

test('classify: unlisted tokens and contracts and dust lots never seed or price', () => {
  const params = paramsFor(cfg, records, 1)
  const s = { seed: [], reference: null }
  assert.equal(
    classify(s, p(10n ** 18n, 1, { token: '0x0000000000000000000000000000000000000001' }), params),
    'not admitted',
  )
  assert.equal(
    classify(s, p(10n ** 18n, 1, { contract: '0x0000000000000000000000000000000000000002' }), params),
    'not admitted',
  )
  assert.equal(classify(s, p(5n * 10n ** 17n - 1n, 1), params), 'dust') // just under MIN_LOT_FLOOR $0.50
  assert.equal(classify(s, p(5n * 10n ** 17n, 1), params), 'seed') // exactly $0.50 meets MIN_LOT
  assert.equal(s.seed.length, 1)
})

test('paramsFor: a parameter event applies from the first epoch of the next quarter', () => {
  const later = [
    ...records,
    {
      kind: 'event',
      source: 'SRA',
      epoch: cfg.activationEpoch + 10,
      name: 'AdmittedListsUpdated',
      fields: { stablecoins: [USDFC], filecoinPayContracts: [FP] },
    },
  ]
  assert.equal(paramsFor(cfg, later, 1).stablecoins.has(AXL), true) // quarter 1 keeps the lists in force at its start
  assert.equal(paramsFor(cfg, later, 2).stablecoins.has(AXL), false)
  assert.equal(paramsFor(cfg, records, 0).contracts.size, 0) // before activation nothing is admitted
  assert.equal(paramsFor(cfg, records, 2).provisional, true) // MIN_LOT(Q>=2) is not computed yet
})

test('auctionPrice halves every 3.5 days, so a week divides it by 4', () => {
  const info = { startPrice: 4n * 10n ** 18n, startTime: 1000 }
  assert.equal(auctionPrice(info, 1000), 4n * 10n ** 18n)
  assert.equal(auctionPrice(info, 1000 + 2 * HALVING_SECONDS), 10n ** 18n)
  assert.equal(auctionPrice({ startPrice: 0n, startTime: 0 }, 5), 0n)
})

test('standing findings: reference outside the sane range, a large pot, and the two auctions disagreeing', () => {
  const c = {
    feeWatch: { filUsdSane: [0.2, 200], potAlertUsd: 50, divergenceRatio: 10, statusRepeatHours: 168, filecoinPay: FP },
  }
  const usd = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n
  const tokens = [
    { symbol: 'axlUSDC', potUsd: usd(500), price: 76n * 10n ** 14n, lastPrint: p(usd(11.5), 75n * 10n ** 14n) },
    { symbol: 'USDFC', potUsd: usd(3), price: 2n * 10n ** 18n, lastPrint: p(usd(1.8), 10n ** 18n) },
  ]
  const f = standingFindings(c, { tokens, reference: p(usd(1498), 10n ** 18n, { tx: '0xabc', epoch: 1 }) })
  assert.deepEqual(
    f.map((x) => x.key),
    ['fees:reference', 'fees:pot:axlUSDC', 'fees:divergence'],
  )
  assert.match(f[1].title, /\$500,/)
  const sane = standingFindings(c, {
    tokens: [{ ...tokens[1], lastPrint: p(usd(3), 10n ** 18n) }],
    reference: p(usd(3), 10n ** 18n, { tx: '0xabc', epoch: 1 }),
  })
  assert.deepEqual(sane, [])
  // a weekly reminder, not a daily one
  const t0 = Date.parse('2026-11-24T00:00:00Z')
  const first = throttle([f[0]], {}, t0)
  assert.equal(throttle([f[0]], first.sent, t0 + 48 * 3600e3).send.length, 0)
  assert.equal(throttle([f[0]], first.sent, t0 + 168 * 3600e3).send.length, 1)
})

test('emailWorthy: a change to the admitted lists or pricing parameters is emailed', () => {
  assert.equal(emailWorthy({ kind: 'event', source: 'SRA', name: 'PricingParamsUpdated' }).severity, 'warn')
  assert.equal(emailWorthy({ kind: 'event', source: 'SRA', name: 'AdmittedListsUpdated' }).severity, 'warn')
})
