#!/usr/bin/env node
// Absence check: alerts when submitShares or the gate check is overdue on chain (lib/absence.js). Runs after the reader,
// holds no key. What it already said is kept in <dataDir>/alerts.json so a person gets a reminder, not a message every
// run. If that file cannot be saved, the worst case is a repeated alert, never a missing one. Exit 1 when overdue.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeRpc } from '../lib/chain.js'
import { absenceFindings, throttle } from '../lib/absence.js'
import { alert } from '../lib/notify.js'

const cfg = JSON.parse(readFileSync(process.argv[2] ?? 'config/calibnet.json', 'utf8'))
const rpc = makeRpc(cfg.rpcUrl)
const chainId = Number(await rpc('eth_chainId'))
if (chainId !== cfg.chainId) throw new Error(`the endpoint reports chain ${chainId}, but ${cfg.network} is chain ${cfg.chainId}`)
const head = Number(await rpc('eth_blockNumber'))
const word = async (address, slot) => BigInt(await rpc('eth_getStorageAt', [address, '0x' + slot.toString(16).padStart(64, '0'), 'latest']))
const low64 = (w) => Number(w & 0xffffffffffffffffn)
const GATE = 0xf9abab00248d945495524c8caf6be2b837274c1becd1964fb3775f62fd6e4600n
const state = {
  head,
  lastSubmitted: low64(await word(cfg.sra, 0x347e624280399e1e720d839edbd7cd00c80c69bf34cd8ee59e27f691732af300n)),
  lastChecked: low64(await word(cfg.swa, GATE)),
  steps: low64(await word(cfg.swa, GATE + 3n)),
}
const findings = absenceFindings(cfg, state)
console.log(`${cfg.network} epoch ${head} · lastSubmittedQuarter ${state.lastSubmitted} · gate ${state.lastChecked}/${state.steps} · ${findings.length ? findings.map((f) => `${f.severity}: ${f.title}`).join('; ') : 'nothing overdue'}`)

const path = join(cfg.dataDir, 'alerts.json')
const before = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
const { send, sent } = throttle(findings, before)
for (const f of send) await alert(f, cfg)
writeFileSync(path, JSON.stringify(sent, null, 2) + '\n')
if (findings.length) process.exitCode = 1
