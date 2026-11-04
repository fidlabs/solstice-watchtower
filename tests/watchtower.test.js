// Every input in this file is a SAMPLE written by hand from FIP-0118 §2.4.2 / §2.4.9 and the solstice
// Solidity sources. None of it is chain data. Run with: npm test
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as dagCbor from '@ipld/dag-cbor'
import { encodeFunctionData, encodeErrorResult } from 'viem'
import { quarterOf, quarterStart, bindingEpoch, dueCalls, epochToTime } from '../lib/chain.js'
import { decodeActorEvent, decodeStreamsState, decodeF02Params, computeWeight, bigFromBytes, idToEthAddress, writeOutcome } from '../site/lib/f02.js'
import { abi, decodeLog, decodeCall, decodeRevert } from '../lib/evm.js'
import { PCT, entry, idAddress, tokenBytes, flat, sampleLog } from './samples.js'
import { slackText, notify } from '../lib/notify.js'

const cfg = JSON.parse(readFileSync(new URL('../config/calibnet.json', import.meta.url), 'utf8'))
const stepTo15 = dagCbor.encode([[[2, flat(15n, 4100000)]]]) // payload of a StepWeightRecords write: stream 2 to 15%

test('quarter numbers are FIP-0118 §2.2\'s; quarter Q settles, and binds, inside quarter Q+1', () => {
  const c = { activationEpoch: 1000, epochsPerQuarter: 2880, postPeriod: 240, verificationWindow: 480 }
  assert.equal(quarterOf(c, 999), 0) // before activation
  assert.equal(quarterOf(c, 1000), 1) // activation opens quarter 1 (the SRA's internal index calls it 0)
  assert.equal(quarterOf(c, 1000 + 2879), 1)
  assert.equal(quarterOf(c, 1000 + 2880), 2) // Start(2): quarter 1's settlement cycle opens (the SRA's quarterStart(1))
  assert.equal(quarterOf({ activationEpoch: 0, epochsPerQuarter: 2880 }, 5000), 0) // activation epoch not chosen yet
  assert.equal(quarterStart(c, 2), 3880)
  assert.equal(bindingEpoch(c, 1), 3880 + 240 + 480) // submitShares(1) becomes callable here, inside quarter 2
  assert.equal(dueCalls(c, { head: 3880 + 720, lastSubmitted: 0, lastChecked: 1, steps: 0 }).quarter, 2)
})

test('f02 event: write-queued for a gate step', () => {
  const ev = { entries: [entry('$type', 'write-queued'), entry('op', 1), entry('effective-epoch', 4100720), entry('payload', stepTo15)] }
  assert.deepEqual(decodeActorEvent(ev, 't'), {
    name: 'write-queued',
    fields: {
      op: 'StepWeightRecords',
      cancellable: false,
      effectiveEpoch: 4100720,
      payload: { updates: [{ id: 2, record: { vStart: '150000000000000000', slope: '0', tStart: 4100000, floor: '150000000000000000', cap: '150000000000000000' } }] },
    },
  })
})

test('f02 event: write-cancelled for a stream op carries the stream id and no payload', () => {
  const ev = { entries: [entry('$type', 'write-cancelled'), entry('op', 3), entry('effective-epoch', 4100720), entry('stream-id', 7)] }
  assert.deepEqual(decodeActorEvent(ev, 't'), { name: 'write-cancelled', fields: { op: 'RemoveStream', cancellable: true, effectiveEpoch: 4100720, streamId: 7 } })
})

test('f02 event: claim-payout', () => {
  const ev = { entries: [entry('$type', 'claim-payout'), entry('stream-id', 2), entry('recipient', 1234), entry('amount', tokenBytes(5n * 10n ** 18n))] }
  assert.deepEqual(decodeActorEvent(ev, 't'), { name: 'claim-payout', fields: { streamId: 2, recipient: 't01234', amountAttoFil: '5000000000000000000' } })
})

test('f02 events added in builtin-actors v19.0.0: period-folded, shares-set, address-replaced', () => {
  const folded = { entries: [entry('$type', 'period-folded'), entry('stream-id', 2), entry('cause', 'SetShares'), entry('accrued', tokenBytes(10n ** 18n)), entry('dust', tokenBytes(3n))] }
  assert.deepEqual(decodeActorEvent(folded, 't'), { name: 'period-folded', fields: { streamId: 2, cause: 'SetShares', accruedAttoFil: '1000000000000000000', dustAttoFil: '3' } })
  const set = { entries: [entry('$type', 'shares-set'), entry('stream-id', 2), entry('shares', [[1011, 750000000000000000n], [1018, 250000000000000000n]])] }
  assert.deepEqual(decodeActorEvent(set, 't').fields.shares, [{ recipient: 't01011', share: '750000000000000000' }, { recipient: 't01018', share: '250000000000000000' }])
  const moved = { entries: [entry('$type', 'address-replaced'), entry('stream-id', 2), entry('old-recipient', 1018), entry('new-recipient', 99)] }
  assert.deepEqual(decodeActorEvent(moved, 't'), { name: 'address-replaced', fields: { streamId: 2, oldRecipient: 't01018', newRecipient: 't099' } })
})

test('f02 state behind streams_root', () => {
  const service = [2, flat(10n, 4000000), [idAddress(5000), [[idAddress(1234), 10n ** 18n]], [[idAddress(1234), tokenBytes(7n)]], []]]
  const state = decodeStreamsState(dagCbor.encode([[[1, flat(90n, 4000000), null], service], [], [[null, 1, stepTo15, 4100720]]]), 't')
  assert.equal(state.streams[0].distribution, null) // consensus stream: IMPLICIT, nothing stored
  assert.deepEqual(state.streams[1].distribution, {
    writer: 't05000',
    shares: [{ recipient: 't01234', share: '1000000000000000000' }],
    payable: [{ recipient: 't01234', amountAttoFil: '7' }],
    claimedPeriod: [],
  })
  assert.equal(state.pendingWrites[0].op, 'StepWeightRecords')
  assert.equal(state.pendingWrites[0].streamId, null) // schedule-wide op
  assert.equal(state.pendingWrites[0].payload.updates[0].record.cap, '150000000000000000')
})

test('ComputeWeight clamps: the Q1 ramp from 5% to 10%', () => {
  const ramp = { vStart: (5n * PCT).toString(), slope: ((5n * PCT) / 2880n).toString(), tStart: 1000, floor: (5n * PCT).toString(), cap: (10n * PCT).toString() }
  assert.equal(computeWeight(ramp, 900), 5n * PCT) // before t_start: clamps at the band edge
  assert.equal(computeWeight(ramp, 1000), 5n * PCT)
  assert.equal(computeWeight(ramp, 1000 + 1440) / PCT, 7n) // half way: about 7.5%
  assert.equal(computeWeight(ramp, 99999), 10n * PCT) // rests at the cap
})

test('byte helpers', () => {
  assert.equal(bigFromBytes(new Uint8Array()), 0n)
  assert.equal(bigFromBytes(Uint8Array.from([1, 1, 0])), -256n)
  assert.equal(idToEthAddress(99), '0xff00000000000000000000000000000000000063') // f099, the burn actor
})

test('contract event: VolumePosted', () => {
  const orch = '0x97A90f5696be5E3C8d3752C92Adac287c2b4484e'
  const log = sampleLog('VolumePosted', { q: 6n, orchestrator: orch, volume: 4200n * 10n ** 18n })
  assert.deepEqual(decodeLog(log),{ name: 'VolumePosted', fields: { q: '6', orchestrator: orch, volume: '4200000000000000000000' } })
  assert.equal(decodeLog({ topics: ['0x' + 'ab'.repeat(32)], data: '0x' }).name, 'unknown(0xabababab)')
})

test('SWA events added in solstice PR #79: GateParamsSet and WeightRecordsQueued', () => {
  const set = decodeLog(sampleLog('GateParamsSet', { params: { target: { base: 3500n * 10n ** 18n, stepRatio: 27n * 10n ** 17n }, steps: 2n } }))
  assert.equal(set.name, 'GateParamsSet')
  assert.deepEqual(set.fields.params, { target: { base: '3500000000000000000000', stepRatio: '2700000000000000000' }, steps: '2' })
  const queued = decodeLog(sampleLog('WeightRecordsQueued', { updates: [{ id: 2n, record: { vStart: 1n, slope: 0n, tStart: 5n, floor: 1n, cap: 1n } }] }))
  assert.equal(queued.name, 'WeightRecordsQueued')
  assert.equal(queued.fields.updates[0].id, '2')
})

test('message: a direct call, and the same call sent through a Safe', () => {
  const input = encodeFunctionData({ abi, functionName: 'postVolume', args: [6n, 123n] })
  assert.deepEqual(decodeCall(input), { name: 'postVolume', fields: { q: '6', fpv: '123' } })

  const sra = '0x00000000000000000000000000000000000000aa'
  const zero = '0x0000000000000000000000000000000000000000'
  const viaSafe = encodeFunctionData({ abi, functionName: 'execTransaction', args: [sra, 0n, input, 0, 0n, 0n, 0n, zero, zero, '0x'] })
  const call = decodeCall(viaSafe)
  assert.equal(call.name, 'postVolume')
  assert.equal(call.innerTo, sra)
  assert.equal(call.innerData, input)
})

test('message: registerStream has two forms', () => {
  const record = { vStart: 1n, slope: 0n, tStart: 5n, floor: 1n, cap: 1n }
  const short = decodeCall(encodeFunctionData({ abi, functionName: 'registerStream', args: [9n, record, 4100720n] }))
  assert.deepEqual(Object.keys(short.fields), ['id', 'record', 'activationEpoch'])
  const long = decodeCall(encodeFunctionData({ abi, functionName: 'registerStream', args: [9n, record, '0x00000000000000000000000000000000000000aa', [], 4100720n] }))
  assert.deepEqual(Object.keys(long.fields), ['id', 'record', 'writer', 'shares', 'activationEpoch'])
})

test('revert reasons', () => {
  assert.equal(decodeRevert(encodeErrorResult({ abi, errorName: 'NotInPostingWindow', args: [6n] })), 'NotInPostingWindow(6)')
  assert.equal(decodeRevert(encodeErrorResult({ abi, errorName: 'StepsComplete' })), 'StepsComplete()')
  assert.equal(decodeRevert('0xdeadbeef'), 'unknown error 0xdeadbeef')
  assert.equal(decodeRevert(undefined), 'reverted (no reason given)')
})

test('outcome of a queued write, judged from the f02 state after its effective epoch', () => {
  const state = (weight2, queue) => decodeStreamsState(dagCbor.encode([[[1, flat(85n, 4000000), null], [2, flat(weight2, 4000000), [idAddress(5000), [], [], []]]], [], queue]), 't')
  const step = decodeStreamsState(dagCbor.encode([[], [], [[null, 1, stepTo15, 4100720]]]), 't').pendingWrites[0] // the queued gate step to 15%
  assert.equal(writeOutcome(step, state(10n, [[null, 1, stepTo15, 4100720]])), 'still queued')
  assert.equal(writeOutcome(step, decodeStreamsState(dagCbor.encode([[[2, flat(15n, 4100000), null]], [], []]), 't')), 'applied')
  assert.equal(writeOutcome(step, state(10n, [])), 'dropped or replaced') // gone from the queue, weight unchanged
  const remove = { op: 'RemoveStream', streamId: 2, effectiveEpoch: 4100720, payload: {} }
  assert.equal(writeOutcome(remove, state(10n, [])), 'dropped or replaced') // stream 2 is still there
  assert.equal(writeOutcome(remove, decodeStreamsState(dagCbor.encode([[[1, flat(85n, 4000000), null]], [], []]), 't')), 'applied')
})

test('parameters of messages sent to f02: Claim, SetShares, ReplaceAddress', () => {
  assert.deepEqual(decodeF02Params('Claim', [2, [idAddress(1011), idAddress(1018)]], 't'), { streamId: 2, wallets: ['t01011', 't01018'] })
  assert.deepEqual(decodeF02Params('SetShares', [2, [[idAddress(1011), 10n ** 18n]]], 't'), { streamId: 2, shares: [{ recipient: 't01011', share: '1000000000000000000' }] })
  assert.deepEqual(decodeF02Params('ReplaceAddress', [2, idAddress(1018), idAddress(99)], 't'), { streamId: 2, oldAddress: 't01018', newAddress: 't099' })
  const f410 = Uint8Array.from([4, 10, ...Buffer.from('97a90f5696be5e3c8d3752c92adac287c2b4484e', 'hex')]) // the wallet bytes of the calibnet Claim of 2026-09-28
  assert.deepEqual(decodeF02Params('Claim', [2, [f410]], 't'), { streamId: 2, wallets: ['0x97a90f5696be5e3c8d3752c92adac287c2b4484e (f410)'] })
  const other = [1, 2]
  assert.equal(decodeF02Params('RemoveStream', other, 't'), other) // unknown shapes pass through
})

test('slack text: one message per run, notable records only, reverted and gap marked', () => {
  const t = '2026-09-28T13:04:00.000Z'
  const records = [
    { kind: 'read', epoch: 1, time: t, source: 'balance', name: 'balance of f099 (burn)', fields: { attoFil: '1' } }, // routine read: left out
    { kind: 'message', epoch: 1, time: t, source: 'SRA', name: 'setAdmittedLists', via: 'sraOwner2', ok: true, fields: { stablecoins: ['0xb3'] } },
    { kind: 'message', epoch: 2, time: t, source: 'SRA', name: 'submitShares', ok: false, error: 'SetSharesFailed(17)', fields: { q: '2' } },
    { kind: 'gap', epoch: 3, time: t, source: 'reader', name: 'could not be read', fields: { fromEpoch: 3, toEpoch: 5 } },
  ]
  const text = slackText(records, { network: 'calibnet' }, 1, 5)
  assert.match(text, /^\*calibnet\* · epochs 1 to 5 · 3 new\n/)
  assert.match(text, /`setAdmittedLists` via sraOwner2 ok · stablecoins: 0xb3/)
  assert.match(text, /`submitShares` FAILED SetSharesFailed\(17\)/)
  assert.match(text, /`could not be read` NOT READ/)
  const withTask = slackText([{ kind: 'event', epoch: 1, time: t, source: 'SRA', name: 'Rejected', fields: { taskId: '0x80be01afc4be8ad0a50900713dc2b3117d811ab1af63dfa1b1926131f90bec6f', owner: '0x6c' } }], { network: 'calibnet' }, 1, 1)
  assert.match(withTask, /taskId: 0x80be01af…, owner: 0x6c/) // the hash is cut in the Slack line only
  const long = slackText([{ kind: 'event', epoch: 1, time: t, source: 'SRA', name: 'AdmittedListsUpdated', fields: { stablecoins: ['0x' + 'b'.repeat(40), '0x' + 'e'.repeat(40)], filecoinPayContracts: ['0x' + '9'.repeat(40)] } }], { network: 'calibnet' }, 1, 1)
  assert.match(long, /filecoinPayContracts: 0x9{40}\n/) // the third address is whole, not cut in the middle
  const huge = slackText([{ kind: 'event', epoch: 1, time: t, source: 'SRA', name: 'x', fields: { list: Array.from({ length: 30 }, (_, i) => '0x' + String(i).padStart(40, '0')) } }], { network: 'calibnet' }, 1, 1)
  assert.match(huge, /0x0{38}\d\d …\n/) // a very long list is cut at a separator, never inside a value
  assert.doesNotMatch(text, /balance/)
  assert.match(text, /\?data=calibnet$/) // calibnet is a secondary view since 2026-10-16
  assert.equal(slackText([records[0]], { network: 'calibnet' }, 1, 5), null) // nothing notable: no message
  assert.match(slackText(records, { network: 'mainnet' }, 1, 5), /solsticewatchtower\.eth\.limo\/$/) // mainnet is the default view
  const withTx = [{ kind: 'event', epoch: 1, time: t, source: 'SRA', name: 'VolumePosted', fields: { q: 1 }, tx: '0xabc' }]
  assert.match(slackText(withTx, { network: 'calibnet' }, 1, 1), /<https:\/\/calibration\.filfox\.info\/en\/message\/0xabc\|message>/)
  assert.doesNotMatch(slackText(withTx, { network: 'devnet' }, 1, 1), /filfox/) // no explorer for an unknown network
})

test('slack outbox: a failed post is kept in status.slackPending and sent first at the next run', async () => {
  process.env.SLACK_WEBHOOK = 'https://hooks.example/test'
  process.env.SLACK_RETRY_MS = '1'
  const sent = []
  let fail = true
  global.fetch = async (url, { body }) => { if (fail) throw new Error('down'); sent.push(JSON.parse(body).text); return { ok: true } }
  const t = '2026-09-28T13:04:00.000Z'
  const rec = (name) => [{ kind: 'event', epoch: 1, time: t, source: 'SRA', name, fields: {} }]
  const status = {}
  await notify(rec('VolumePosted'), { network: 'calibnet' }, 1, 2, status) // Slack down: three tries, then kept
  assert.equal(sent.length, 0)
  assert.equal(status.slackPending.length, 1)
  assert.match(status.slackPending[0], /VolumePosted/)
  fail = false
  await notify(rec('SharesSubmitted'), { network: 'calibnet' }, 3, 4, status) // next run: the kept one first, then the new one
  assert.deepEqual(sent.map((x) => /VolumePosted|SharesSubmitted/.exec(x)[0]), ['VolumePosted', 'SharesSubmitted'])
  assert.deepEqual(status.slackPending, [])
  delete process.env.SLACK_WEBHOOK
})

test('backup cranker: what is due comes from chain state and the binding epoch alone', () => {
  const c = { activationEpoch: 1000, epochsPerQuarter: 2880, postPeriod: 240, verificationWindow: 480 }
  const b1 = bindingEpoch(c, 1) // 4600
  // before activation, and in quarter 1: nothing to submit yet; the gate starts at lastChecked 1
  assert.deepEqual(dueCalls(c, { head: 900, lastSubmitted: 0, lastChecked: 1, steps: 0 }).due, [])
  assert.deepEqual(dueCalls(c, { head: 3000, lastSubmitted: 0, lastChecked: 1, steps: 0 }).due, [])
  // quarter 2 started (quarter 1's cycle) but quarter 1 not bound yet: still nothing
  assert.deepEqual(dueCalls(c, { head: b1 - 1, lastSubmitted: 0, lastChecked: 1, steps: 0 }).due.map((d) => d.key), [])
  // quarter 1 bound: submitShares(1), possible since its binding. The gate waits for quarter 2.
  const d = dueCalls(c, { head: b1, lastSubmitted: 0, lastChecked: 1, steps: 0 })
  assert.deepEqual(d.due.map((x) => [x.key, x.since]), [['submitShares(1)', b1]])
  // two quarters late: only the latest bound quarter is submittable, never an older one
  const b3 = bindingEpoch(c, 3)
  assert.deepEqual(dueCalls(c, { head: b3 + 5, lastSubmitted: 0, lastChecked: 1, steps: 0 }).due.map((x) => x.key), ['submitShares(3)', 'quarterlyGateCheck(2)'])
  // already submitted, gate settled or complete
  assert.deepEqual(dueCalls(c, { head: b3 + 5, lastSubmitted: 3, lastChecked: 3, steps: 2 }).due, [])
  assert.deepEqual(dueCalls(c, { head: b3 + 5, lastSubmitted: 3, lastChecked: 1, steps: 8 }).due, [])
})

test('absence: submitShares warns after absenceAlertHours, turns critical past the backup delay, gate warns after 48 h', async () => {
  const { absenceFindings } = await import('../lib/absence.js')
  const c = { activationEpoch: 1000, epochsPerQuarter: 2880 * 91, postPeriod: 8640, verificationWindow: 20160, epochSeconds: 30, crankDelayEpochs: 2880 }
  const b1 = bindingEpoch(c, 1)
  const at = (head) => absenceFindings(c, { head, lastSubmitted: 0, lastChecked: 1, steps: 0 })
  assert.deepEqual(at(b1 + 100), []) // bound 50 minutes ago: not yet
  assert.deepEqual(at(b1 + 720).map((f) => [f.key, f.severity]), [['submitShares(1)', 'warn']]) // 6 hours
  assert.deepEqual(at(b1 + 2880 + 720).map((f) => f.severity), ['critical']) // a day + 6 h: the backup should have sent it too
  assert.match(at(b1 + 720)[0].text, /share map is lost for good/)
  assert.deepEqual(absenceFindings(c, { head: b1 + 720, lastSubmitted: 1, lastChecked: 1, steps: 0 }), [])
  const b2 = bindingEpoch(c, 2)
  const gate = absenceFindings(c, { head: b2 + 5760, lastSubmitted: 2, lastChecked: 1, steps: 0 })
  assert.deepEqual(gate.map((f) => [f.key, f.severity]), [['quarterlyGateCheck(2)', 'warn']])
})

test('absence: reminders are throttled, escalations go at once, and recoveries are announced', async () => {
  const { throttle } = await import('../lib/absence.js')
  const t0 = Date.parse('2027-01-29T00:00:00Z')
  const warn = [{ key: 'submitShares(1)', severity: 'warn', title: 't', text: '' }]
  const first = throttle(warn, {}, t0)
  assert.equal(first.send.length, 1)
  assert.equal(throttle(warn, first.sent, t0 + 3600e3).send.length, 0) // an hour later: quiet
  assert.equal(throttle(warn, first.sent, t0 + 24 * 3600e3).send.length, 1) // a day later: reminder
  const crit = [{ ...warn[0], severity: 'critical' }]
  assert.equal(throttle(crit, first.sent, t0 + 60e3).send[0].severity, 'critical') // escalation: at once
  const done = throttle([], first.sent, t0 + 60e3)
  assert.deepEqual(done.send.map((f) => f.title), ['resolved: submitShares(1) has landed'])
  assert.deepEqual(done.sent, {})
})
