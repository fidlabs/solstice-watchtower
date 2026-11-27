#!/usr/bin/env node
// Fee-auction check: recomputes FIP-0118's FIL price (Section 2.3) from every Filecoin Pay fee-auction claim, and alerts
// on what could make FIL volume count for more than it is worth. Runs after the reader, holds no key.
// Usage: node bin/fees.js config/mainnet.json   (a config without feeWatch is skipped)
//
// What it alerts on, for every admitted stablecoin (today USDFC and axlUSDC):
//   info, Slack only  each claim: lot, FIL paid, implied $/FIL, and whether the rule seeds, accepts or rejects it
//   warn              a claim that takes only part of the pot, pays above the auction price, or comes from a new
//                     claimer: a buyer choosing the print rather than harvesting fees
//   warn, weekly      while it holds: the price reference is outside feeWatch.filUsdSane, a pot is at least
//                     feeWatch.potAlertUsd, or the two auctions' last prints disagree by more than divergenceRatio
//   warn              a binding whose payer is its operator; a FIL rail on a bound payer/operator pair
//   critical          FIL settled on a bound payer/operator pair: Orchestrator volume priced at the reference
// The FIP pricing state and what was sent are kept in <dataDir>/fees.json. Exit 1 on a critical finding or an error;
// a standing warning alone does not fail the job (it would stay red for weeks and hide real failures).
//
// Claims are found by tracing: burnForFees emits no event, and a claim made inside a multicall carries its FIL in an
// internal call. Any block in which a token leaves Filecoin Pay is traced (trace_block); a claim is a successful call
// to an admitted Filecoin Pay contract with burnForFees' selector. The node keeps traces for 14 days only.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseAbi, encodeFunctionData, decodeFunctionData, decodeFunctionResult, decodeEventLog, pad } from 'viem'
import { makeRpc, toHex, epochToTime, quarterOf } from '../lib/chain.js'
import { abi as solsticeAbi } from '../lib/evm.js'
import { paramsFor, classify, claimLine, standingFindings, auctionPrice, usdPerFil, lotUsd, fmt } from '../lib/fees.js'
import { throttle } from '../lib/absence.js'
import { alert } from '../lib/notify.js'

const LAG = 5
const LOG_CHUNK = 360
const MAX_EPOCHS_PER_RUN = Number(process.env.FEES_MAX_EPOCHS ?? 2880)
const LOOKBACK = 38_000 // under the node's 14-day (40,320-epoch) trace and state limit, with room for a slow run
const ZERO = '0x0000000000000000000000000000000000000000'
const BURN_FOR_FEES = '0x1a257300'

const fpAbi = parseAbi([
  'function burnForFees(address token, address recipient, uint256 requested) payable',
  'function accounts(address token, address owner) view returns (uint256 funds, uint256 lockupCurrent, uint256 lockupRate, uint256 lockupLastSettledAt)',
  'function auctionInfo(address token) view returns (uint88 startPrice, uint168 startTime)',
  'struct RailView { address token; address from; address to; address operator; address validator; uint256 paymentRate; uint256 lockupPeriod; uint256 lockupFixed; uint256 settledUpTo; uint256 endEpoch; uint256 commissionRateBps; address serviceFeeRecipient; }',
  'struct RailInfo { uint256 railId; bool isTerminated; uint256 endEpoch; }',
  'function getRail(uint256 railId) view returns (RailView)',
  'function getRailsForPayerAndToken(address payer, address token, uint256 offset, uint256 limit) view returns (RailInfo[] results, uint256 nextOffset, uint256 total)',
  'event RailCreated(uint256 indexed railId, address indexed payer, address indexed payee, address token, address operator, address validator, address serviceFeeRecipient, uint256 commissionRateBps)',
  'event RailSettled(uint256 indexed railId, uint256 totalSettledAmount, uint256 totalNetPayeeAmount, uint256 operatorCommission, uint256 networkFee, uint256 settledUpTo)',
  'event RailOneTimePaymentProcessed(uint256 indexed railId, uint256 netPayeeAmount, uint256 operatorCommission, uint256 networkFee)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }',
  'function aggregate3Value(Call3Value[] calls) payable',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])
const TOPIC = {
  Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
}

const cfg = JSON.parse(readFileSync(process.argv[2] ?? 'config/calibnet.json', 'utf8'))
const w = cfg.feeWatch
if (!w) {
  console.log(`${cfg.network}: no feeWatch in the config, nothing to do`)
  process.exit(0)
}
// Glif is a pool of nodes and some of them miss blocks ("ipld: could not find", 2026-11-24): the same call usually
// succeeds on a retry that lands elsewhere. Other errors are passed on.
const rpcOnce = makeRpc(cfg.rpcUrl)
const MISSING = /ipld: could not find|failed to load/
async function rpc(method, params) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rpcOnce(method, params)
    } catch (err) {
      if (!MISSING.test(err.message) || attempt === 8) throw err
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
}
const chainId = Number(await rpc('eth_chainId'))
if (chainId !== cfg.chainId)
  throw new Error(`the endpoint reports chain ${chainId}, but ${cfg.network} is chain ${cfg.chainId}`)

const statePath = join(cfg.dataDir, 'fees.json')
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : {
      lastEpoch: w.startEpoch - 1,
      pricing: { seed: [], reference: null },
      prints: [],
      rails: {},
      bindingsSeen: [],
      sent: {},
    }
state.tokens ??= {}
const records = readFileSync(join(cfg.dataDir, 'records.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))

const head = Number(await rpc('eth_blockNumber'))
const events = [] // one-off alerts of this run
let failed = false

const call = async (to, abi, functionName, args, block = 'latest') => {
  const data = encodeFunctionData({ abi, functionName, args })
  const out = await rpc('eth_call', [{ to, data }, typeof block === 'number' ? toHex(block) : block])
  return decodeFunctionResult({ abi, functionName, data: out })
}
// state "before" a block: the nearest earlier height that is not a null round
const callBefore = async (to, abi, fn, args, epoch) => {
  for (let e = epoch - 1; e >= epoch - 10; e--) {
    try {
      return await call(to, abi, fn, args, e)
    } catch (err) {
      if (!/null round|no tipset|not found|requested epoch/i.test(err.message)) throw err
    }
  }
  throw new Error(`no state found within 10 epochs before ${epoch}`)
}
async function token(address) {
  address = address.toLowerCase()
  if (!state.tokens[address]) {
    const known = Object.entries(w.tokens).find(([a]) => a.toLowerCase() === address)?.[1]
    state.tokens[address] = known ?? {
      symbol: await call(address, fpAbi, 'symbol', []).catch(() => address.slice(0, 10)),
      decimals: Number(await call(address, fpAbi, 'decimals', [])),
    }
  }
  return state.tokens[address]
}
// eth_getLogs in chunks. Glif fails some ranges with "failed to load event message ... ipld: could not find" (seen on
// USDFC transfers, 2026-11-24): such a range is halved until the failing block is found, and that block is returned in
// `unreadable` so the caller can trace it or say it could not be read.
const UNREADABLE = /failed to load event message|ipld: could not find/
async function getLogs(filter, from, to) {
  const logs = [],
    unreadable = []
  const range = async (a, b) => {
    try {
      logs.push(...(await rpc('eth_getLogs', [{ ...filter, fromBlock: toHex(a), toBlock: toHex(b) }])))
    } catch (err) {
      if (!UNREADABLE.test(err.message)) throw err
      if (a === b) return unreadable.push(a)
      const m = Math.floor((a + b) / 2)
      await range(a, m)
      await range(m + 1, b)
    }
  }
  for (let a = from; a <= to; a += LOG_CHUNK) await range(a, Math.min(to, a + LOG_CHUNK - 1))
  return { logs, unreadable }
}

// 1. The window to scan, inside the node's lookback.
let from = state.lastEpoch + 1
const to = Math.min(head - LAG, from + MAX_EPOCHS_PER_RUN - 1)
if (from < head - LOOKBACK) {
  events.push({
    key: `fees:gap:${from}`,
    severity: 'critical',
    title: `the fee-auction check fell behind: epochs ${from} to ${head - LOOKBACK - 1} can no longer be traced`,
    text: 'The node keeps traces for 14 days. Claims in that range are missing from the FIL price computed here; check them on an explorer.',
  })
  state.gaps = [...(state.gaps ?? []), { fromEpoch: from, toEpoch: head - LOOKBACK - 1 }]
  from = head - LOOKBACK
}

try {
  if (to >= from) {
    const fpContracts = [w.filecoinPay.toLowerCase()]

    // 2. Claims: trace every block in which a watched token left Filecoin Pay. The tokens are named (the admitted
    // stablecoins plus feeWatch.tokens): Glif fails a topic-only eth_getLogs over some ranges ("ipld: could not find"),
    // and a claim of an unlisted token prices nothing. It does count toward N(Q-1) in MIN_LOT(Q); see paramsFor.
    const watched = [
      ...new Set(
        [...Object.keys(w.tokens), ...paramsFor(cfg, records, quarterOf(cfg, to)).stablecoins].map((a) =>
          a.toLowerCase(),
        ),
      ),
    ]
    const outflows = await getLogs(
      { address: watched, topics: [TOPIC.Transfer, fpContracts.map((a) => pad(a))] },
      from,
      to,
    )
    const blocks = [...new Set([...outflows.logs.map((l) => Number(l.blockNumber)), ...outflows.unreadable])].sort(
      (a, b) => a - b,
    )
    for (const b of blocks) {
      const traces = await framesOf(
        b,
        outflows.logs.filter((l) => Number(l.blockNumber) === b),
      )
      const failedAt = new Set(
        traces.filter((t) => t.error).map((t) => `${t.transactionHash}:${t.traceAddress.join('.')}`),
      )
      const reverted = (t) =>
        t.traceAddress.some((_, i) => failedAt.has(`${t.transactionHash}:${t.traceAddress.slice(0, i).join('.')}`)) ||
        failedAt.has(`${t.transactionHash}:${t.traceAddress.join('.')}`)
      let pos = 0
      for (const t of traces) {
        const a = t.action ?? {}
        if (!a.input?.startsWith(BURN_FOR_FEES) || !fpContracts.includes(a.to?.toLowerCase()) || reverted(t)) continue
        const { args } = decodeFunctionData({ abi: fpAbi, data: a.input })
        const tok = await token(args[0])
        const p = {
          epoch: b,
          time: epochToTime(cfg, b),
          quarter: quarterOf(cfg, b),
          tx: t.transactionHash,
          pos: pos++,
          contract: a.to.toLowerCase(),
          token: args[0].toLowerCase(),
          symbol: tok.symbol,
          lot: args[2].toString(),
          fil: BigInt(a.value).toString(),
          claimer: args[1],
          sender: a.from,
        }
        p.usd = lotUsd(p, tok.decimals).toString()
        await steeringSignals(p, tok)
        const params = paramsFor(cfg, records, p.quarter)
        p.status = classify(state.pricing, p, params)
        if (params.provisional && p.status !== 'not admitted') p.provisional = true
        state.prints.push(p)
        const admitted = p.status !== 'not admitted'
        events.push({
          key: `fees:claim:${p.tx}:${p.pos}`,
          severity: 'info',
          email: false,
          title: claimLine(p, p.symbol),
        })
        const why = [
          p.partial && 'took part of the pot',
          p.overpaid && 'paid above the auction price',
          p.unknownClaimer && 'a claimer not seen before',
        ]
          .filter(Boolean)
          .join(', ')
        if (admitted && why)
          events.push({
            key: `fees:steer:${p.tx}:${p.pos}`,
            severity: 'warn',
            title: `a ${p.symbol} fee-auction claim looks chosen, not harvested: ${why}`,
            text:
              `${claimLine(p, p.symbol)}\n` +
              (p.available
                ? `Pot before the claim ${fmt.usd(Number(lotUsd({ lot: p.available }, tok.decimals)) / 1e18)}. `
                : '') +
              (p.minPrice ? `Auction price ${fmt.fil(p.minPrice)}. ` : '') +
              `A buyer who picks the lot and the FIL paid picks the printed $/FIL, within PRICE_BAND of the reference.\n${w.explorerTx}${p.tx}`,
          })
      }
    }

    // 3. FIL rails and settlements on bound pairs.
    const railLogs = await getLogs({ address: w.filecoinPay }, from, to)
    if (railLogs.unreadable.length)
      events.push({
        key: `fees:unreadable:${railLogs.unreadable.join(',')}`,
        severity: 'warn',
        title: `Filecoin Pay events could not be read at epoch(s) ${railLogs.unreadable.join(', ')}`,
        text: 'The node failed to load them. A FIL settlement on a bound pair in those blocks would be missed; check them on an explorer.',
      })
    for (const l of railLogs.logs) {
      let ev
      try {
        ev = decodeEventLog({ abi: fpAbi, data: l.data, topics: l.topics })
      } catch {
        continue
      }
      if (!['RailCreated', 'RailSettled', 'RailOneTimePaymentProcessed'].includes(ev.eventName)) continue
      const epoch = Number(l.blockNumber)
      const rail = await railOf(ev.args.railId, epoch)
      if (!rail || rail.token !== ZERO) continue
      const orch = await call(cfg.sra, solsticeAbi, 'bindingOf', [rail.from, rail.operator])
      if (orch === ZERO) continue
      const pairText = `payer ${rail.from}, operator ${rail.operator}, bound to Orchestrator ${orch}`
      if (ev.eventName === 'RailCreated') {
        events.push({
          key: `fees:filrail:${ev.args.railId}`,
          severity: 'warn',
          title: `a FIL rail (#${ev.args.railId}) was opened on a bound pair`,
          text: `${pairText}. FIL settled on it counts as Orchestrator volume, priced at the fee-auction reference.\n${w.explorerTx}${l.transactionHash}`,
        })
        continue
      }
      const amount =
        ev.eventName === 'RailSettled'
          ? ev.args.totalSettledAmount
          : ev.args.netPayeeAmount + ev.args.operatorCommission + ev.args.networkFee
      if (amount === 0n) continue
      const ref = state.pricing.reference
      const valued = ref ? fmt.usd((Number(amount) / 1e18) * usdPerFil(ref)) : 'nothing yet (no price reference)'
      events.push({
        key: `fees:filsettle:${l.transactionHash}:${l.logIndex}`,
        severity: 'critical',
        title: `${fmt.fil(amount)} settled on a bound pair (rail #${ev.args.railId}), worth ${valued} of Orchestrator volume`,
        text:
          `${pairText}. FIP-0118 values FIL volume at the next qualifying fee-auction print` +
          (ref ? `; the reference now is ${fmt.usd(usdPerFil(ref))}/FIL (${ref.tx}).` : '.') +
          `\n${w.explorerTx}${l.transactionHash}`,
      })
    }
  }

  // 4. Bindings, from the reader's record: a payer bound as its own operator, and FIL rails on a newly bound pair.
  for (const r of records) {
    if (r.kind !== 'event' || r.source !== 'SRA' || !['BindingDeclared', 'BindingReassigned'].includes(r.name)) continue
    const { payer, operator, orchestrator } = r.fields
    const id = `${r.tx}:${payer}:${operator}`.toLowerCase()
    if (state.bindingsSeen.includes(id)) continue
    state.bindingsSeen.push(id)
    if (payer.toLowerCase() === operator.toLowerCase())
      events.push({
        key: `fees:selfbind:${id}`,
        severity: 'warn',
        title: `${payer} is bound as its own payer and operator (Orchestrator ${orchestrator})`,
        text:
          `A pair whose payer is its operator can settle payments to itself and have them counted as Orchestrator volume. ` +
          `In FIL, that volume is valued at the fee-auction reference. Epoch ${r.epoch}, ${w.explorerTx}${r.tx}`,
      })
    const { results } = await call(w.filecoinPay, fpAbi, 'getRailsForPayerAndToken', [payer, ZERO, 0n, 100n]).then(
      (x) => ({
        results: x[0],
      }),
    )
    for (const ri of results) {
      const rail = await railOf(ri.railId, 'latest')
      if (rail?.operator.toLowerCase() === operator.toLowerCase())
        events.push({
          key: `fees:filrail:${ri.railId}`,
          severity: 'warn',
          title: `a FIL rail (#${ri.railId}) exists on the newly bound pair ${payer} / ${operator}`,
          text: `Bound to Orchestrator ${orchestrator}. FIL settled on it counts as Orchestrator volume, priced at the fee-auction reference.`,
        })
    }
  }

  // 5. Standing state of each admitted stablecoin's auction.
  const now = paramsFor(cfg, records, quarterOf(cfg, head)) // the lists in force this quarter
  const tokens = []
  for (const address of now.stablecoins) {
    const tok = await token(address)
    const [funds] = await call(w.filecoinPay, fpAbi, 'accounts', [address, w.filecoinPay])
    const [startPrice, startTime] = await call(w.filecoinPay, fpAbi, 'auctionInfo', [address])
    const price = auctionPrice({ startPrice, startTime }, cfg.genesisTimestamp + head * cfg.epochSeconds)
    const lastPrint = state.prints.filter((p) => p.token === address).at(-1) ?? null
    tokens.push({ symbol: tok.symbol, address, potUsd: lotUsd({ lot: funds }, tok.decimals), price, lastPrint })
  }
  const standing = standingFindings(cfg, { tokens, reference: state.pricing.reference })
  const { send, sent } = throttle(standing, state.sent, Date.now(), (key) => `resolved: ${key} no longer holds`)
  state.sent = sent
  events.push(...send)

  state.lastEpoch = Math.max(state.lastEpoch, to)
  state.lastRun = new Date().toISOString()
  state.status = Object.fromEntries(
    tokens.map((t) => [
      t.symbol,
      {
        potUsd: Number(t.potUsd) / 1e18,
        auctionPriceFil: Number(t.price) / 1e18,
        wholePotUsdPerFil: t.price ? usdPerFil({ usd: t.potUsd.toString(), fil: t.price.toString() }) : null,
        lastPrintUsdPerFil: t.lastPrint ? usdPerFil(t.lastPrint) : null,
      },
    ]),
  )
  state.status.referenceUsdPerFil = state.pricing.reference ? usdPerFil(state.pricing.reference) : null
} catch (err) {
  failed = true
  console.error(`fees: ${err.stack ?? err.message}`)
  events.push({
    key: 'fees:error',
    severity: 'warn',
    email: false,
    title: `the fee-auction check failed: ${err.message.slice(0, 200)}`,
  })
}

// A failed run saves nothing, so the next run starts again from the same epoch and no claim is counted twice.
if (!failed) writeFileSync(statePath, JSON.stringify(state, null, 1) + '\n')
const ref = state.pricing.reference
console.log(
  `${cfg.network} fees · epochs to ${state.lastEpoch} · ${state.prints.length} claims · reference ${ref ? fmt.usd(usdPerFil(ref)) + '/FIL' : 'not seeded'} · ${events.length} alert(s)`,
)
for (const e of events) await alert(e, cfg)
if (failed || events.some((e) => e.severity === 'critical')) process.exitCode = 1

// Read the pot and the auction around a claim. A harvester takes the whole pot at the auction price; a claim that takes
// part of it, or pays more than the price, chose its own rate. After a claim, auctionInfo holds 4x the price paid.
async function steeringSignals(p, tok) {
  p.unknownClaimer = !w.knownClaimers.some((a) => a.toLowerCase() === p.claimer.toLowerCase())
  try {
    const [[before], [after]] = await Promise.all([
      callBefore(p.contract, fpAbi, 'accounts', [p.token, p.contract], p.epoch),
      call(p.contract, fpAbi, 'accounts', [p.token, p.contract], p.epoch),
    ])
    const available = before > after ? before : after
    p.available = available.toString()
    const left = available - BigInt(p.lot)
    const dust = BigInt(Math.round(w.partialToleranceUsd * 10 ** tok.decimals))
    p.partial = left > dust
    const ts = cfg.genesisTimestamp + p.epoch * cfg.epochSeconds
    for (const info of [
      await call(p.contract, fpAbi, 'auctionInfo', [p.token], p.epoch),
      await callBefore(p.contract, fpAbi, 'auctionInfo', [p.token], p.epoch),
    ]) {
      if (Number(info[1]) === ts) {
        const min = BigInt(info[0]) / 4n
        p.minPrice = min.toString()
        p.overpaid = BigInt(p.fil) * 100n > min * BigInt(100 + w.overpayPercent)
      }
    }
  } catch (err) {
    p.signalsError = err.message.slice(0, 160) // the claim is still classified; only the steering checks are missing
  }
}

// The call frames of a block, from trace_block. When the node cannot trace it (a pool member missing the block, after
// rpc()'s retries), they are rebuilt from the transactions that moved tokens out of Filecoin Pay: a direct burnForFees,
// or one inside Multicall3's aggregate3Value. Anything else is reported, not guessed.
async function framesOf(b, logs) {
  try {
    return await rpc('trace_block', [toHex(b)])
  } catch (err) {
    if (!MISSING.test(err.message)) throw err
  }
  if (!logs.length) {
    events.push({
      key: `fees:untraced:${b}`,
      severity: 'warn',
      title: `epoch ${b} could not be traced or its logs read; a fee-auction claim there would be missed`,
    })
    return []
  }
  const frames = []
  for (const hash of new Set(logs.map((l) => l.transactionHash))) {
    // The Transfer log is proof the transaction succeeded (a reverted one leaves no logs); Glif's receipts can be null.
    let tx = null
    for (let i = 0; i < 8 && !tx; i++) {
      tx = await rpc('eth_getTransactionByHash', [hash])
      if (!tx) await new Promise((r) => setTimeout(r, 1500))
    }
    // A claim that cannot be seen at all fails the run, which saves nothing and tries again next time: skipping it
    // would leave the price reference wrong for good. If the node never serves it, the lookback alert says so.
    if (!tx) throw new Error(`epoch ${b}: neither the trace nor transaction ${hash} could be read from the node`)
    const moved = new Set(logs.filter((l) => l.transactionHash === hash).map((l) => l.address.toLowerCase()))
    const frame = (to, input, value) => ({
      transactionHash: hash,
      traceAddress: [],
      action: { from: tx.from, to, input, value: toHex(value) },
    })
    if (tx.input.startsWith(BURN_FOR_FEES)) {
      frames.push(frame(tx.to, tx.input, BigInt(tx.value)))
    } else if (tx.input.startsWith('0x174dea71')) {
      for (const c of decodeFunctionData({ abi: fpAbi, data: tx.input }).args[0]) {
        if (!c.callData.startsWith(BURN_FOR_FEES)) continue
        const tokenMoved = moved.has(decodeFunctionData({ abi: fpAbi, data: c.callData }).args[0].toLowerCase())
        if (tokenMoved) frames.push(frame(c.target, c.callData, c.value)) // a sub-call allowed to fail counts only if its token moved
      }
    } else {
      events.push({
        key: `fees:untraced:${hash}`,
        severity: 'warn',
        title: `a token left Filecoin Pay in ${hash} (epoch ${b}), which could not be traced or decoded`,
        text: `If it was a fee-auction claim it is missing from the FIL price computed here.\n${w.explorerTx}${hash}`,
      })
    }
  }
  return frames
}

async function railOf(railId, block) {
  const id = String(railId)
  if (state.rails[id]) return state.rails[id]
  try {
    const r = await call(w.filecoinPay, fpAbi, 'getRail', [BigInt(id)], block)
    state.rails[id] = { token: r.token.toLowerCase(), from: r.from, operator: r.operator }
  } catch {
    return null // finalized rails revert; a settlement event is always read while the rail is live
  }
  return state.rails[id]
}
