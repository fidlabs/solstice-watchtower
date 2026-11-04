#!/usr/bin/env node
// Claim keeper: sends f02 `Claim(id, wallets)` for every wallet f02 owes something to, when nobody has claimed that
// stream for claimEveryHours (default 24). The wallets are read from the f02 state: the share map and payable rows of
// each live stream, the payable rows of each tombstone. Each batch (at most 64 wallets, FIP-0118 §2.4.9) is simulated
// first (Filecoin.StateCall returns the amounts) and sent only if it pays more than 0, its maximum fee is under
// claimMaxFeeFil and that fee is at most 10% of what it pays.
// "When was this stream last claimed" comes from the record (site/data/<net>/records.jsonl), which the reader job writes
// just before this runs: any successful Claim message on the stream counts, whoever sent it. Nothing is written back.
// Claim is permissionless and the FIL always goes to the wallets in the map (FIP-0118 §2.4.5), so this key only pays
// gas. It must be an f1 account: repository secret CLAIM_KEY, whose address must match
// cfg.wallets["claimer (watchtower backup)"]; without the secret the run is a dry run. Exit 1 when something failed.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as dagCbor from '@ipld/dag-cbor'
import { RPC } from 'iso-filecoin/rpc'
import { Message } from 'iso-filecoin/message'
import { accountFromPrivateKey, signMessage } from 'iso-filecoin/wallet'
import { fromString } from 'iso-filecoin/address'
import { makeRpc } from '../lib/chain.js'
import { alert } from '../lib/notify.js'
import { decodeStreamsState, bigFromBytes } from '../site/lib/f02.js'

const cfg = JSON.parse(readFileSync(process.argv[2] ?? 'config/calibnet.json', 'utf8'))
const CLAIM = 4045527845 // f02 method number of Claim (FRC-0042), as in bin/reader.js
const MAX_RECIPIENTS = 64 // FIP-0118 §2.4.9: Claim checks this before resolving wallets
const EVERY_EPOCHS = Math.round((cfg.claimEveryHours ?? 24) * 3600 / cfg.epochSeconds)
const MAX_FEE = BigInt(Math.round(Number(cfg.claimMaxFeeFil ?? 0.05) * 1e6)) * 10n ** 12n
const MAX_FEE_PERCENT = 10n
const claimer = cfg.wallets?.['claimer (watchtower backup)']
const network = cfg.network === 'mainnet' ? 'mainnet' : 'testnet'
const key = process.env.CLAIM_KEY?.trim().replace(/^0x/, '')
const account = key ? accountFromPrivateKey(Buffer.from(key, 'hex'), 'SECP256K1', network) : null
if (account && account.address.toString() !== claimer) throw new Error(`CLAIM_KEY is the key of ${account.address}, not of the configured claimer ${claimer}`)
const fil = (atto) => (Number(atto / 10n ** 12n) / 1e6).toFixed(6)

// The last successful Claim on each stream that the record holds, by epoch.
const lastClaim = new Map()
const recordsPath = join(cfg.dataDir, 'records.jsonl')
if (existsSync(recordsPath)) {
  for (const line of readFileSync(recordsPath, 'utf8').split('\n')) {
    if (!line.includes('"Claim"')) continue
    const r = JSON.parse(line)
    if (r.kind === 'message' && r.source === 'f02' && r.name === 'Claim' && r.ok && r.fields?.streamId !== undefined) lastClaim.set(Number(r.fields.streamId), r.epoch)
  }
}

const rpc = makeRpc(cfg.rpcUrl)
const head = (await rpc('Filecoin.ChainHead', [])).Height
const { State } = await rpc('Filecoin.StateReadState', [cfg.f02, null])
const root = Object.values(State).find((v) => v && typeof v === 'object' && '/' in v)?.['/']
if (!root) { console.log(`${cfg.network} claim: f02 has no stream state yet (before activation)`); process.exit(0) }
const st = decodeStreamsState(Buffer.from(await rpc('Filecoin.ChainReadObj', [{ '/': root }]), 'base64'), cfg.addressPrefix)
const unique = (rows) => [...new Set(rows.map((r) => r.recipient))]
const chunk = (list) => Array.from({ length: Math.ceil(list.length / MAX_RECIPIENTS) }, (_, i) => list.slice(i * MAX_RECIPIENTS, (i + 1) * MAX_RECIPIENTS))
const batches = [
  ...st.streams.filter((s) => s.distribution).map((s) => ({ id: s.id, wallets: unique([...s.distribution.shares, ...s.distribution.payable]) })),
  ...st.tombstones.map((t) => ({ id: t.id, wallets: unique(t.payable) })),
].filter((b) => b.wallets.length).flatMap((b) => chunk(b.wallets).map((wallets) => ({ id: b.id, wallets })))
console.log(`${cfg.network} claim · epoch ${head} · ${batches.length} batch(es) · every ${cfg.claimEveryHours ?? 24} h · ${account ? 'key ' + claimer : 'DRY RUN, no key'}`)

const iso = new RPC({ api: cfg.rpcUrl, network })
const failures = []
for (const b of batches) {
  const label = `claim(${b.id}, ${b.wallets.length} wallet(s))`
  try {
    const last = lastClaim.get(b.id)
    if (last !== undefined && head - last < EVERY_EPOCHS) { console.log(`${label}: last claimed at epoch ${last}, next after ${last + EVERY_EPOCHS}`); continue }
    const params = Buffer.from(dagCbor.encode([b.id, b.wallets.map((w) => fromString(w).toBytes())])).toString('base64')
    const sim = { Version: 0, To: cfg.f02, From: claimer, Nonce: 0, Value: '0', GasLimit: 0, GasFeeCap: '0', GasPremium: '0', Method: CLAIM, Params: params }
    const { MsgRct } = await rpc('Filecoin.StateCall', [sim, null])
    if (MsgRct.ExitCode !== 0) throw new Error(`simulation exit code ${MsgRct.ExitCode}`)
    const amounts = dagCbor.decode(Buffer.from(MsgRct.Return, 'base64'))[0].map(bigFromBytes) // a one-field tuple holding amounts[]
    const payout = amounts.reduce((s, a) => s + a, 0n)
    if (payout === 0n) { console.log(`${label}: nothing to pay`); continue }
    if (!account) { console.log(`${label}: would pay ${fil(payout)} FIL (dry run)`); continue }

    // Nonce discipline: never stack a message on one of ours that is still pending.
    const actor = await rpc('Filecoin.StateGetActor', [claimer, null]).catch(() => null)
    const nonce = await rpc('Filecoin.MpoolGetNonce', [claimer])
    if (actor && Number(actor.Nonce) !== Number(nonce)) throw new Error(`${claimer} has ${Number(nonce) - Number(actor.Nonce)} message(s) pending; not sending on top`)

    const m = await new Message({ to: cfg.f02, from: claimer, value: '0', method: CLAIM, params }).prepare(iso)
    const maxFee = BigInt(m.gasLimit) * BigInt(m.gasFeeCap)
    if (maxFee > MAX_FEE || maxFee * 100n > payout * MAX_FEE_PERCENT) {
      console.log(`${label}: not sent, max fee ${fil(maxFee)} FIL against a payout of ${fil(payout)} FIL (cap ${fil(MAX_FEE)} FIL, at most ${MAX_FEE_PERCENT}%)`)
      continue
    }
    const res = await iso.pushMessage({ msg: m, signature: signMessage(account.privateKey, 'SECP256K1', m) })
    if (res.error) throw res.error
    console.log(`${label}: sent ${res.result['/']}, pays ${fil(payout)} FIL, max fee ${fil(maxFee)} FIL`)
  } catch (err) {
    failures.push(label)
    console.error(`${label}: FAILED ${err.message}`)
    await alert({ severity: 'warn', title: `Claim keeper: ${label} failed`, text: String(err.message).slice(0, 300) }, cfg)
  }
}
if (failures.length) process.exitCode = 1
