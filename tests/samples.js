// Builders for SAMPLE inputs, written from FIP-0118 §2.4.2 / §2.4.9 and the solstice ABI. Used by the tests
// and by bin/make-sample.js. They produce raw inputs in the shape the node returns, so the real decoders run on them.
import * as dagCbor from '@ipld/dag-cbor'
import { encodeEventTopics, encodeAbiParameters } from 'viem'
import { abi } from '../lib/evm.js'

export const PCT = 10n ** 16n // one percentage point at DENOM = 10^18

// one entry of an actor event, as Filecoin.GetActorEventsRaw returns it
export const entry = (Key, value) => ({
  Flags: 3,
  Key,
  Codec: 81,
  Value: Buffer.from(dagCbor.encode(value)).toString('base64'),
})

// Address bytes in ID form: protocol byte 00, then LEB128
export function idAddress(id) {
  const out = [0]
  for (let n = BigInt(id); ;) {
    const b = Number(n & 0x7fn)
    n >>= 7n
    out.push(n ? b | 0x80 : b)
    if (!n) break
  }
  return Uint8Array.from(out)
}

// TokenAmount bytes: sign byte 00, then big-endian magnitude
export const tokenBytes = (n) =>
  Uint8Array.from(Buffer.from('00' + ((h) => (h.length % 2 ? '0' + h : h))(n.toString(16)), 'hex'))

// WeightRecord tuple [v_start, slope, t_start, floor, cap] held flat at pct percent
export const flat = (pct, tStart) => [pct * PCT, 0, tStart, pct * PCT, pct * PCT]

// a contract log, as eth_getLogs returns it
export function sampleLog(eventName, args) {
  const rest = abi.find((x) => x.type === 'event' && x.name === eventName).inputs.filter((i) => !i.indexed)
  return {
    topics: encodeEventTopics({ abi, eventName, args }),
    data: encodeAbiParameters(
      rest,
      rest.map((i) => args[i.name]),
    ),
  }
}
