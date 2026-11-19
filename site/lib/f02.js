// Decoders for the reward actor (f02): its actor events and the state behind streams_root.
// Layouts follow FIP-0118 §2.4.2 (state, encoding) and §2.4.9 (actor events), PR #1286 head a1a0a8b,
// checked against builtin-actors master eb9c308 actors/reward/src/emit.rs.
// This file runs in Node (the reader) and in the browser (the page's live read), so it uses no Node-only API.
// In the page, the import below is resolved by the import map in index.html.
import * as dagCbor from '@ipld/dag-cbor'

// §2.4.2 PendingWriteOp, "encoded as the displayed integer".
export const OPS = ['SetWeightRecords', 'StepWeightRecords', 'RegisterStream', 'RemoveStream', 'SetDistribution']

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
export const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const str = (n) => BigInt(n).toString()

// Big integers (TokenAmount): one sign byte (00 +, 01 -), then big-endian magnitude, empty for zero.
export function bigFromBytes(bytes) {
  if (bytes.length === 0) return 0n
  const n = BigInt('0x' + (hex(bytes.subarray(1)) || '0'))
  return bytes[0] === 1 ? -n : n
}

// Address bytes in ID form: protocol byte 00, then the LEB128 actor ID. Anything else stays raw hex.
export function addressFromBytes(bytes, prefix = 'f') {
  // A delegated address in the EVM namespace (protocol 4, namespace 10, an f410 address) carries a plain 20-byte
  // Ethereum address: show that, as the rest of the page does. Other non-ID forms keep their raw bytes.
  if (bytes[0] === 4 && bytes[1] === 10 && bytes.length === 22) return '0x' + hex(bytes.subarray(2)) + ' (f410)'
  if (bytes[0] !== 0) return '0x' + hex(bytes)
  let id = 0n
  let shift = 0n
  for (const b of bytes.subarray(1)) {
    id |= BigInt(b & 0x7f) << shift
    shift += 7n
  }
  return `${prefix}0${id}`
}

// The Ethereum-style address of an ID address: 0xff, 11 zero bytes, then the ID as 8 bytes.
export const idToEthAddress = (id) => '0xff' + BigInt(id).toString(16).padStart(38, '0')

// WeightRecord tuple: [v_start, slope, t_start, floor, cap]; fractions are fixed point with DENOM = 10^18.
const weightRecord = ([vStart, slope, tStart, floor, cap]) => ({
  vStart: str(vStart),
  slope: str(slope),
  tStart: Number(tStart),
  floor: str(floor),
  cap: str(cap),
})

// §2.4.1 ComputeWeight: clamp(v_start + slope * (e - t_start), floor, cap). Returns a fraction of 10^18.
export function computeWeight(w, epoch) {
  const x = BigInt(w.vStart) + BigInt(w.slope) * BigInt(epoch - w.tStart)
  const [lo, hi] = [BigInt(w.floor), BigInt(w.cap)]
  return x < lo ? lo : x > hi ? hi : x
}

// Generic view of decoded CBOR for parts with no named layout here: bytes -> hex, big ints -> strings.
function plain(v, prefix) {
  if (v instanceof Uint8Array) return v[0] === 0 && v.length <= 11 ? addressFromBytes(v, prefix) : '0x' + hex(v)
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return v.map((x) => plain(x, prefix))
  if (v && typeof v === 'object') return v.toString() // a CID
  return v
}

// The payload of a pending write, by op (§2.4.2):
//   0,1: [ [ [id, WeightRecord], .. ] ]   2: [WeightRecord, Option<DistributionInit>]   3: []   4: [ Address ]
export function decodePayload(op, payloadBytes, prefix = 'f') {
  const t = dagCbor.decode(payloadBytes)
  if (op === 0 || op === 1) return { updates: t[0].map(([id, w]) => ({ id: Number(id), record: weightRecord(w) })) }
  if (op === 2) return { record: weightRecord(t[0]), distribution: plain(t[1], prefix) }
  if (op === 4) return { writer: addressFromBytes(t[0], prefix) }
  return {}
}

// One actor event as Filecoin.GetActorEventsRaw returns it: entries of { Key, Codec, Value (base64 DAG-CBOR) }.
// Returns { name, fields }. Field names are the event keys of §2.4.9.
export function decodeActorEvent(event, prefix = 'f') {
  const kv = {}
  for (const e of event.entries) kv[e.Key] = dagCbor.decode(fromBase64(e.Value))
  const name = kv.$type
  const fields = {}
  if ('op' in kv) {
    fields.op = OPS[Number(kv.op)] ?? `unknown(${kv.op})`
    fields.cancellable = Number(kv.op) !== 1 // StepWeightRecords is "uncancellable" (§2.4.2)
  }
  if ('effective-epoch' in kv) fields.effectiveEpoch = Number(kv['effective-epoch'])
  if ('stream-id' in kv) fields.streamId = Number(kv['stream-id'])
  if ('payload' in kv) fields.payload = decodePayload(Number(kv.op), kv.payload, prefix)
  if ('recipient' in kv) fields.recipient = `${prefix}0${kv.recipient}`
  if ('amount' in kv) fields.amountAttoFil = bigFromBytes(kv.amount).toString()
  // period-folded, shares-set, address-replaced: builtin-actors v19.0.0, actors/reward/src/emit.rs at 3662c66
  if ('cause' in kv) fields.cause = kv.cause
  if ('accrued' in kv) fields.accruedAttoFil = bigFromBytes(kv.accrued).toString()
  if ('dust' in kv) fields.dustAttoFil = bigFromBytes(kv.dust).toString()
  if ('shares' in kv) fields.shares = kv.shares.map(([r, s]) => ({ recipient: `${prefix}0${r}`, share: String(s) }))
  if ('old-recipient' in kv) fields.oldRecipient = `${prefix}0${kv['old-recipient']}`
  if ('new-recipient' in kv) fields.newRecipient = `${prefix}0${kv['new-recipient']}`
  return { name, fields }
}

// The block streams_root links to (§2.4.2): [streams, tombstones, pending_writes_queue].
export function decodeStreamsState(bytes, prefix = 'f') {
  const [streams, tombstones, queue] = dagCbor.decode(bytes)
  const amounts = (rows) =>
    rows.map(([r, a]) => ({ recipient: addressFromBytes(r, prefix), amountAttoFil: bigFromBytes(a).toString() }))
  return {
    streams: streams.map(([id, w, dist]) => ({
      id: Number(id),
      weight: weightRecord(w),
      distribution: dist && {
        writer: addressFromBytes(dist[0], prefix),
        shares: dist[1].map(([r, s]) => ({ recipient: addressFromBytes(r, prefix), share: str(s) })),
        payable: amounts(dist[2]),
        claimedPeriod: amounts(dist[3]),
      },
    })),
    tombstones: tombstones.map(([id, payable]) => ({ id: Number(id), payable: amounts(payable) })),
    pendingWrites: queue.map(([id, op, payload, effectiveEpoch]) => ({
      streamId: id === null ? null : Number(id),
      op: OPS[Number(op)] ?? `unknown(${op})`,
      cancellable: Number(op) !== 1,
      payload: decodePayload(Number(op), payload, prefix),
      effectiveEpoch: Number(effectiveEpoch),
    })),
  }
}

// One pending-write slot: the queue holds at most one write per (op, stream id).
export const slotOf = (w) => `${w.op}|${w.streamId ?? ''}`

// What happened to a queued write, judged from the f02 state (decoded by decodeStreamsState) read AFTER its
// effective epoch. f02 writes no visible event when a due write takes effect or is dropped inside a block reward
// (FIP-0118 §2.4.9), so the state is the only evidence:
//   still in the queue                      -> 'still queued'
//   gone, and the state shows the payload   -> 'applied'
//   gone, and the state does not show it    -> 'dropped or replaced'  (a later write may have overwritten it)
export function writeOutcome(write, state) {
  if (state.pendingWrites.some((p) => slotOf(p) === slotOf(write) && p.effectiveEpoch === write.effectiveEpoch))
    return 'still queued'
  const stream = (id) => state.streams.find((s) => s.id === id)
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  let shown
  if (write.op === 'SetWeightRecords' || write.op === 'StepWeightRecords')
    shown = write.payload.updates.every((u) => same(stream(u.id)?.weight, u.record))
  else if (write.op === 'RegisterStream') shown = same(stream(write.streamId)?.weight, write.payload.record)
  else if (write.op === 'RemoveStream') shown = !stream(write.streamId)
  else if (write.op === 'SetDistribution') shown = stream(write.streamId)?.distribution?.writer === write.payload.writer
  return shown ? 'applied' : 'dropped or replaced'
}

// Parameters of a message sent to f02, as CBOR-decoded by the caller (builtin-actors actors/reward/src/types.rs at 3662c66).
// Unknown methods are returned as they are.
export function decodeF02Params(method, v, prefix = 'f') {
  const addr = (b) => addressFromBytes(b, prefix)
  const str = (x) => (typeof x === 'bigint' ? x.toString() : String(x))
  switch (method) {
    case 'Claim':
      return { streamId: Number(v[0]), wallets: v[1].map(addr) }
    case 'SetShares':
      return { streamId: Number(v[0]), shares: v[1].map(([r, sh]) => ({ recipient: addr(r), share: str(sh) })) }
    case 'ReplaceAddress':
      return { streamId: Number(v[0]), oldAddress: addr(v[1]), newAddress: addr(v[2]) }
    default:
      return v
  }
}
