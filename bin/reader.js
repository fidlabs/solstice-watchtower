#!/usr/bin/env node
// One run of the reader: fetch what is new since the last run, append it to the record, move the cursor.
// Usage: node bin/reader.js config/calibnet.json
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as dagCbor from '@ipld/dag-cbor'
import { encodeFunctionData, decodeFunctionResult } from 'viem'
import { makeRpc, toHex, epochToTime, quarterOf } from '../lib/chain.js'
import { decodeActorEvent, decodeStreamsState, decodeF02Params, idToEthAddress, slotOf, writeOutcome, computeWeight } from '../site/lib/f02.js'
import { abi, decodeLog, decodeCall, decodeRevert, plain } from '../lib/evm.js'
import { notify } from '../lib/notify.js'

// ponytail: no reorg handling. The reader stays LAG epochs behind the head; a deeper reorg can leave an
// orphaned line in the append-only record. Upgrade: re-check the last N epochs on every run.
const LAG = 5
// ponytail: messages are found by downloading every block (~50 KB each). Fine at one run per 10 minutes;
// if that gets slow, move to an indexer or Filecoin.StateListMessages on a node that allows it.
// 720 epochs = 6 hours of chain. It was 120 (1 hour) until 2026-09-18: GitHub then started the job about once an
// hour or less, so each run read less chain than had passed and the record fell behind after every late run.
const MAX_EPOCHS_PER_RUN = 720
const LOG_CHUNK = 360
const ZERO = '0x0000000000000000000000000000000000000000'
// f02 state fields that change every epoch: left out of the record, so a 'f02 state' line means a real change. The four
// FIP-0118 counters (TotalMintedReward, TotalBurnMinted, TotalExplicitMinted, Accrued) move with every block reward too;
// they are readable live. The f099 (burn) balance was a per-run read until 2026-09-25; it moves every epoch, so it wrote
// one line per run on every network and was dropped from the record (the page can read it live).
const NOISY = ['Epoch', 'ThisEpochReward', 'TotalStoragePowerReward', 'ThisEpochRewardSmoothed', 'CumsumBaseline', 'CumsumRealized', 'EffectiveBaselinePower', 'ThisEpochBaselinePower', 'EffectiveNetworkTime',
  'TotalMintedReward', 'TotalBurnMinted', 'TotalExplicitMinted', 'Accrued']

const cfg = JSON.parse(readFileSync(process.argv[2] ?? 'config/calibnet.json', 'utf8'))
const rpc = makeRpc(cfg.rpcUrl)
mkdirSync(cfg.dataDir, { recursive: true })
const statusPath = join(cfg.dataDir, 'status.json')
const recordsPath = join(cfg.dataDir, 'records.jsonl')
const status = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, 'utf8')) : { lastEpoch: null, reads: {} }
// Queued writes the reader has seen and whose outcome it has not recorded yet, kept between runs in status.json.
status.pending ??= {}

// address -> name, lower case. A contract still at the zero address is not deployed yet and is skipped.
const contracts = new Map([['SRA', cfg.sra], ['SWA', cfg.swa]].filter(([, a]) => a !== ZERO).map(([n, a]) => [a.toLowerCase(), n]))
// address -> label, for the "via" of a message sent through a known multisig
const names = new Map(Object.entries({ ...cfg.owners, ...cfg.wallets }).map(([n, a]) => [a.toLowerCase(), n]))

const chainHead = Number(await rpc('eth_blockNumber'))
const from = status.lastEpoch === null ? (cfg.startEpoch ?? chainHead - LAG - 20) : status.lastEpoch + 1
const to = Math.min(chainHead - LAG, from + (cfg.maxEpochsPerRun ?? MAX_EPOCHS_PER_RUN) - 1)
if (to < from) {
  console.log(`nothing new: last epoch read ${status.lastEpoch}, chain head ${chainHead}`)
  process.exit(0)
}

const records = []
const rec = (kind, epoch, source, name, fields, extra = {}) =>
  records.push({ kind, epoch, time: epochToTime(cfg, epoch), quarter: quarterOf(cfg, epoch), source, name, fields, ...extra })

// 1. f02 actor events. A node can have this API switched off; that is recorded, and the run goes on.
// A node's event index can be a few seconds behind its chain head ("events for the requested block are not yet
// available"), so the read is tried three times, 10 seconds apart, before a gap is recorded.
let f02Events = []
for (let attempt = 1; ; attempt++) {
  try {
    f02Events = []
    for (let a = from; a <= to; a += LOG_CHUNK) f02Events.push(...((await rpc('Filecoin.GetActorEventsRaw', [{ addresses: [cfg.f02], fromHeight: a, toHeight: Math.min(to, a + LOG_CHUNK - 1) }])) ?? [])) // same 360-block cap as eth_getLogs
    break
  } catch (err) {
    if (attempt < 3) { await new Promise((r) => setTimeout(r, 10_000)); continue }
    rec('gap', from, 'reader', 'f02 events could not be read', { fromEpoch: from, toEpoch: to, reason: err.message.slice(0, 160) })
    break
  }
}
for (const ev of f02Events) {
  if (ev.reverted) continue
  const extra = { msgCid: ev.msgCid?.['/'], raw: ev.entries }
  let decoded
  try {
    decoded = decodeActorEvent(ev, cfg.addressPrefix)
  } catch (err) {
    decoded = { name: 'undecoded', fields: { error: err.message } } // the raw entries are still saved
  }
  rec('event', ev.height, 'f02', decoded.name, decoded.fields, extra)
  if (decoded.name === 'claim-payout') await claimCheck(ev.height, decoded.fields)
  if (decoded.name === 'write-queued') watchWrite(decoded.fields)
  if (decoded.name === 'write-cancelled') delete status.pending[pendingKey(decoded.fields)]
}

// A Claim is checked twice: the event gives recipient and amount, the wallet balance must move by the same amount.
async function claimCheck(epoch, { recipient, amountAttoFil }) {
  const wallet = idToEthAddress(recipient.slice(2))
  const [before, after] = await Promise.all([epoch - 1, epoch + 1].map((e) => rpc('eth_getBalance', [wallet, toHex(e)])))
  const difference = (BigInt(after) - BigInt(before)).toString()
  rec('read', epoch + 1, 'f02', 'claim check', { recipient, amountAttoFil, balanceBefore: BigInt(before).toString(), balanceAfter: BigInt(after).toString(), difference, matches: difference === amountAttoFil })
}

const unreadable = [] // epochs whose block the node could not serve; recorded as a gap, never hidden

if (contracts.size) {
  // 2. SRA and SWA events
  // The public endpoint caps one eth_getLogs query (2880 blocks on 2026-09-18, 360 on one answer of 2026-09-23), so the range is read in chunks.
  // Same "not yet available" lag as the f02 read above (run #2241, 2026-10-13): three attempts, 10 seconds apart; a
  // third failure still fails the run, and the next run starts again from the last committed epoch.
  const logs = []
  for (let attempt = 1; ; attempt++) {
    try {
      logs.length = 0
      for (let a = from; a <= to; a += LOG_CHUNK) logs.push(...await rpc('eth_getLogs', [{ address: [...contracts.keys()], fromBlock: toHex(a), toBlock: toHex(Math.min(to, a + LOG_CHUNK - 1)) }]))
      break
    } catch (err) {
      if (attempt === 3) throw err
      await new Promise((r) => setTimeout(r, 10_000))
    }
  }
  for (const log of logs) {
    const { name, fields } = decodeLog(log)
    rec('event', Number(log.blockNumber), contracts.get(log.address.toLowerCase()), name, fields, { tx: log.transactionHash, raw: { topics: log.topics, data: log.data } })
  }

  // 3. messages to the SRA or the SWA, direct or through any Safe, with their result. Until 2026-09-30 only the four
  // owner Safes were followed, so failed calls through an Orchestrator's Safe were invisible (they leave no event).
  for (let epoch = from; epoch <= to; epoch++) {
    let block
    try {
      block = await rpc('eth_getBlockByNumber', [toHex(epoch), true])
    } catch (err) {
      if (/null round/.test(err.message)) continue // an epoch with no block
      unreadable.push({ epoch, reason: err.message.slice(0, 160) }) // usually: the node no longer keeps this block
      continue
    }
    for (const tx of block?.transactions ?? []) {
      const sentTo = tx.to?.toLowerCase()
      const call = decodeCall(tx.input ?? '0x')
      const target = call.innerTo ?? sentTo
      if (!contracts.has(target)) continue // not a call to the SRA or the SWA
      const receipt = await rpc('eth_getTransactionReceipt', [tx.hash])
      // a Safe message can succeed while the call inside it fails: the Safe then emits ExecutionFailure
      const innerFailed = receipt.logs.some((l) => decodeLog(l).name === 'ExecutionFailure')
      const ok = receipt.status === '0x1' && !innerFailed
      // Out of gas (all gas used): the chain keeps no reason. A replay with enough gas shows whether the call would
      // have failed anyway (all five seen on 2026-09-29 would have).
      const outOfGas = !ok && BigInt(receipt.gasUsed) === BigInt(tx.gas)
      const replay = () => call.innerTo ? replayReason(sentTo, target, call.innerData, call.innerValue, epoch) : replayReason(tx.from, target, tx.input, tx.value, epoch)
      // A direct call: the chain keeps its revert reason in the receipt. A call sent through a multisig: the
      // receipt holds the multisig's own result, so the reason of the call inside it needs a replay.
      const error = ok ? undefined : outOfGas ? `out of gas (gas limit ${BigInt(tx.gas)}); ${await replay()}` : call.innerTo ? await replay() : await receiptReason(tx.hash)
      rec('message', epoch, contracts.get(target), call.name, call.fields, { from: tx.from, via: call.innerTo ? names.get(sentTo) ?? sentTo : undefined, ok, error, tx: tx.hash, raw: { input: tx.input } })
    }
  }
}

// 3b. messages sent to f02 itself (Claim, and any direct call of a stream method). These are native Filecoin
// messages, so they are not in the Eth blocks above. Only from the activation epoch on: before it, f02 has no
// such methods. ponytail: two more requests per epoch; drop when an index serves messages by address.
// Method numbers: solstice src/lib/FVMRewardMethod.sol (FRC-0042 hashes of the method names).
const F02_METHODS = { 386660827: 'RegisterStream', 1623858416: 'RemoveStream', 3362570548: 'SetWeightRecords', 3951753085: 'StepWeightRecords', 3872725033: 'SetDistribution', 187585191: 'CancelPending', 2414422607: 'SetShares', 4045527845: 'Claim', 3068846150: 'ReplaceAddress' }
const f02Id = cfg.f02.slice(1) // "t02" and "f02" name the same actor
for (let epoch = Math.max(from, cfg.activationEpoch || Infinity); epoch <= to; epoch++) {
  let messages
  try {
    const tipset = await rpc('Filecoin.ChainGetTipSetByHeight', [epoch, null])
    if (tipset.Height !== epoch) continue // a null round: the node answers with the tipset before it
    messages = await rpc('Filecoin.ChainGetMessagesInTipset', [tipset.Cids])
  } catch (err) {
    unreadable.push({ epoch, reason: err.message.slice(0, 160) })
    continue
  }
  for (const { Cid, Message: m } of messages ?? []) {
    if (m.To.slice(1) !== f02Id) continue
    const receipt = (await rpc('Filecoin.StateSearchMsg', [null, Cid, -1, true]))?.Receipt
    const name = F02_METHODS[m.Method] ?? `method ${m.Method}`
    let fields
    try {
      const v = m.Params ? dagCbor.decode(Buffer.from(m.Params, 'base64')) : null
      const decoded = v === null ? null : decodeF02Params(name, v, cfg.addressPrefix)
      fields = decoded === v ? { params: plainCbor(v) } : decoded
    } catch {
      fields = { params: m.Params } // kept as sent
    }
    rec('message', epoch, 'f02', name, fields, { from: m.From, ok: receipt?.ExitCode === 0, error: receipt?.ExitCode ? `exit code ${receipt.ExitCode}` : undefined, msgCid: Cid['/'] })
  }
}
function plainCbor(v) {
  return v instanceof Uint8Array ? '0x' + Buffer.from(v).toString('hex') : typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map(plainCbor) : v
}

// Cross-check with rvagg's Lotus node, which serves Filecoin.StateRewardDistribution (the f02 split of one tipset's
// reward, after due writes). Optional: that node is not a public service, so a failed call is only logged. The weights
// the watchtower computes from the stored records and the share map it decodes must equal the node's; a difference is
// recorded as "distribution check" (nothing is recorded when they agree). The node's burn share of the minted reward is
// recorded as a read, rounded to 0.01%, so it writes a line only when the split really moves (a removal, a new stream).
async function distributionCheck(state) {
  let d
  try {
    d = await makeRpc(cfg.distributionRpcUrl)('Filecoin.StateRewardDistribution', [{ tag: 'latest' }])
  } catch (err) {
    console.log(`distribution check skipped: ${err.message.slice(0, 120)}`)
    return
  }
  const block = d.Blocks?.[0]
  if (!block) return
  const diffs = []
  for (const st of block.Streams) {
    const ours = state.streams.find((x) => x.id === Number(st.ID))
    if (!ours) { diffs.push(`stream ${st.ID}: in the node, not in the f02 state read`); continue }
    const w = computeWeight(ours.weight, d.Height).toString()
    if (w !== st.Weight) diffs.push(`stream ${st.ID} weight: watchtower ${w}, node ${st.Weight}`)
    const nodeShares = (st.Distribution?.Recipients ?? []).map((r) => `${r.Recipient}:${r.Share}`).sort().join(',')
    const ourShares = (ours.distribution?.shares ?? []).map((r) => `${r.recipient}:${r.share}`).sort().join(',')
    if (nodeShares !== ourShares) diffs.push(`stream ${st.ID} share map: watchtower [${ourShares}], node [${nodeShares}]`)
  }
  for (const ours of state.streams) if (!block.Streams.some((st) => Number(st.ID) === ours.id)) diffs.push(`stream ${ours.id}: in the f02 state read, not in the node`)
  if (diffs.length) rec('read', d.Height, 'f02', 'distribution check', { height: d.Height, matches: false, differences: diffs })
  const t = d.Totals
  if (t && BigInt(t.MintedReward) > 0n) {
    const burnBps = (BigInt(t.BurnAllocation) * 10000n / BigInt(t.MintedReward)).toString()
    await read('f02', 'burn share of the block reward (node)', async () => ({ basisPoints: burnBps, note: 'BurnAllocation / MintedReward, from Filecoin.StateRewardDistribution' }))
  }
}

// Rule: a gap that cannot be read is recorded, not hidden. Consecutive epochs become one record.
for (let i = 0; i < unreadable.length; ) {
  let j = i
  while (j + 1 < unreadable.length && unreadable[j + 1].epoch === unreadable[j].epoch + 1) j++
  rec('gap', unreadable[i].epoch, 'reader', 'could not be read', { fromEpoch: unreadable[i].epoch, toEpoch: unreadable[j].epoch, reason: unreadable[i].reason })
  i = j + 1
}

// The reason as stored on chain: the message receipt's Return is a CBOR byte string holding the revert data.
async function receiptReason(txHash) {
  const cid = await rpc('Filecoin.EthGetMessageCidByTransactionHash', [txHash])
  const found = await rpc('Filecoin.StateSearchMsg', [null, cid, -1, true])
  const ret = found?.Receipt?.Return
  return decodeRevert(ret ? '0x' + Buffer.from(dagCbor.decode(Buffer.from(ret, 'base64'))).toString('hex') : undefined)
}

// ponytail: the replay runs on the state of the epoch before, so another message in the same epoch can change
// the outcome; the result is labeled as a replay for that reason.
async function replayReason(sender, target, data, value, epoch) {
  try {
    await rpc('eth_call', [{ from: sender, to: target, data, value: toHex(value ?? 0) }, toHex(epoch - 1)])
    return 'replay did not revert'
  } catch (err) {
    return `${decodeRevert(err.rpc?.data)} (from a replay)`
  }
}

function pendingKey(w) { return `${slotOf(w)}|${w.effectiveEpoch}` }
function watchWrite(w) { status.pending[pendingKey(w)] ??= { op: w.op, streamId: w.streamId, effectiveEpoch: w.effectiveEpoch, payload: w.payload } }

// The f02 stream state as it was at a past epoch.
async function streamsAt(epoch) {
  const tipset = await rpc('Filecoin.ChainGetTipSetByHeight', [epoch, null])
  const { State } = await rpc('Filecoin.StateReadState', [cfg.f02, tipset.Cids])
  const root = Object.values(State).find((v) => v && typeof v === 'object' && '/' in v)?.['/']
  if (!root) throw new Error('f02 has no stream state at that epoch')
  return decodeStreamsState(Buffer.from(await rpc('Filecoin.ChainReadObj', [{ '/': root }]), 'base64'), cfg.addressPrefix)
}

// 4. reads: values that leave no event. A read is recorded only when its value changed since the last run.
async function read(source, name, fn) {
  let fields
  try {
    fields = await fn()
  } catch (err) {
    fields = { error: err.message }
  }
  const json = JSON.stringify(fields)
  if (status.reads[name] === json) return
  status.reads[name] = json
  rec('read', chainHead, source, name, fields)
}

async function view(address, functionName, args = []) {
  const data = encodeFunctionData({ abi, functionName, args })
  try {
    const out = decodeFunctionResult({ abi, functionName, data: await rpc('eth_call', [{ to: address, data }, 'latest']) })
    const outputName = abi.find((x) => x.type === 'function' && x.name === functionName).outputs[0].name || 'result'
    return { [outputName]: plain(out) }
  } catch (err) {
    return { reverted: decodeRevert(err.rpc?.data) }
  }
}

let streamsRoot, headStreams
await read('f02', 'f02 state', async () => {
  const { State } = await rpc('Filecoin.StateReadState', [cfg.f02, null])
  streamsRoot = Object.values(State).find((v) => v && typeof v === 'object' && '/' in v)?.['/'] // the one CID in the state
  return Object.fromEntries(Object.entries(State).filter(([k]) => !NOISY.includes(k)))
})
if (streamsRoot) {
  await read('f02', 'f02 streams', async () => {
    const state = decodeStreamsState(Buffer.from(await rpc('Filecoin.ChainReadObj', [{ '/': streamsRoot }]), 'base64'), cfg.addressPrefix)
    state.pendingWrites.forEach(watchWrite) // the queue in the state is the second source of queued writes, next to the events
    headStreams = state
    return state
  })
}
if (headStreams && cfg.distributionRpcUrl) await distributionCheck(headStreams)

// 5. outcome of every queued write, read at its effective epoch. f02 writes no visible event when a due write takes
// effect or is dropped inside a block reward (FIP-0118 §2.4.9), so the state is the only evidence. A write with
// effective epoch E is handled while tipset E executes, so its effect shows in the state of tipset E+1; E+2 is read
// too when E+1 still shows it queued (an epoch without a block).
for (const [key, write] of Object.entries(status.pending)) {
  const E = write.effectiveEpoch
  if (E + 2 > chainHead - LAG) continue // not due yet
  let outcome, readAt
  try {
    for (readAt of [E + 1, E + 2]) {
      outcome = writeOutcome(write, await streamsAt(readAt))
      if (outcome !== 'still queued') break
    }
  } catch (err) {
    outcome = `could not be read: ${err.message.slice(0, 120)}` // usually: the node no longer keeps that state
  }
  if (outcome === 'still queued' && chainHead - E < 20) continue // give it a few more epochs before saying so
  rec('read', readAt, 'f02', 'queued write outcome', { op: write.op, streamId: write.streamId ?? null, effectiveEpoch: E, outcome, readAtEpoch: readAt, payload: write.payload })
  delete status.pending[key]
}
for (const [label, address] of Object.entries(cfg.wallets)) {
  // an f1 wallet (the claimer) has no 0x form that eth_getBalance accepts; the native call takes both
  await read('balance', `balance of ${label}`, async () => ({ address, attoFil: BigInt(address.startsWith('0x') ? await rpc('eth_getBalance', [address, 'latest']) : await rpc('Filecoin.WalletBalance', [address])).toString() }))
}
const sra = [...contracts].find(([, n]) => n === 'SRA')?.[0]
if (sra) {
  const q = quarterOf(cfg, chainHead)
  await read('SRA', 'SRA admittedCount', () => view(sra, 'admittedCount'))
  await read('SRA', 'SRA orchestratorCount', () => view(sra, 'orchestratorCount'))
  for (const past of [q - 1, q - 2].filter((x) => x >= 1)) {
    await read('SRA', `SRA aggregatedFilecoinPayVolume(${past})`, () => view(sra, 'aggregatedFilecoinPayVolume', [BigInt(past)]))
  }
  // Per-Orchestrator posted value for the current quarter and the last one (fpvOf), and the Orchestrator each
  // registered pair points to (bindingOf). Orchestrators and pairs come from the record's own events (rvagg's
  // suggested reads, 2026-09-21). fpvOf reads 0 for a quarter whose slot was erased by a newer write.
  const { orchestrators, pairs } = knownFromRecord()
  for (const orch of orchestrators) for (const qq of [q, q - 1].filter((x) => x >= 1)) {
    await read('SRA', `SRA fpvOf(${qq}, ${orch})`, () => view(sra, 'fpvOf', [BigInt(qq), orch]))
  }
  for (const [payer, operator] of pairs) {
    await read('SRA', `SRA bindingOf(${payer}, ${operator})`, () => view(sra, 'bindingOf', [payer, operator]))
  }
}

// Admitted Orchestrators and registered pairs, replayed from the events already in the record plus this run's.
function knownFromRecord() {
  const past = existsSync(recordsPath) ? readFileSync(recordsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  const orchestrators = new Set(), pairs = new Map()
  for (const r of [...past, ...records]) {
    if (r.kind !== 'event' || r.source !== 'SRA') continue
    if (r.name === 'OrchestratorAdmitted') orchestrators.add(r.fields.orch)
    if (r.name === 'OrchestratorRemoved') orchestrators.delete(r.fields.orch)
    if (r.name === 'BindingDeclared' || r.name === 'BindingReassigned') pairs.set(`${r.fields.payer}|${r.fields.operator}`, [r.fields.payer, r.fields.operator])
    if (r.name === 'BindingCanceled') pairs.delete(`${r.fields.payer}|${r.fields.operator}`)
  }
  return { orchestrators: [...orchestrators], pairs: [...pairs.values()] }
}

records.sort((a, b) => a.epoch - b.epoch)
if (records.length) appendFileSync(recordsPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
// rpcUrl, f02 and addressPrefix are here for the page's live read of f02
const { network, rpcUrl, f02, addressPrefix, genesisTimestamp, epochSeconds, activationEpoch, epochsPerQuarter, swaTimelockEpochs, postPeriod, verificationWindow, swa } = cfg
console.log(`epochs ${from}..${to} (chain head ${chainHead}): ${records.length} new records -> ${recordsPath}`)
await notify(records, cfg, from, to, status) // Slack, only when SLACK_WEBHOOK is set and the network is not opted out; a failed post waits in status.slackPending
writeFileSync(statusPath, JSON.stringify({ network, rpcUrl, f02, addressPrefix, genesisTimestamp, epochSeconds, activationEpoch, epochsPerQuarter, swaTimelockEpochs, postPeriod, verificationWindow, swa, lastEpoch: to, lastRun: new Date().toISOString(), reads: status.reads, pending: status.pending, slackPending: status.slackPending }, null, 2))
