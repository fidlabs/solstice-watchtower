#!/usr/bin/env node
// Backup cranker: sends the two permissionless Solstice calls when they are due and nobody else sent them.
//   submitShares(q)       on the SRA, for the latest bound quarter q while lastSubmittedQuarter < q
//   quarterlyGateCheck()  on the SWA, once quarter lastCheckedQuarter + 1 is bound and steps < 8
// Each call is simulated first (eth_call); a call that would revert is never sent, so a run with nothing due costs
// nothing. Backup, not a race: a call is sent only once its quarter has been bound for crankDelayEpochs (30 minutes on
// calibnet, one day on mainnet), which leaves the primary cranker (fidlabs/solstice-cranker) time to act first.
// The delay is measured from the binding epoch, which is a pure function of the chain and the config, so nothing has to
// be remembered between runs: a run that cannot save state can never reset the clock and keep the backup from firing.
// Quarter numbers are the SRA's (lib/chain.js). Without CRANK_KEY the run is a dry run. Exit 1 when something failed.
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseEther, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { abi, decodeRevert } from '../lib/evm.js'
import { dueCalls } from '../lib/chain.js'
import { alert } from '../lib/notify.js'

const cfg = JSON.parse(readFileSync(process.argv[2] ?? 'config/calibnet.json', 'utf8'))
const DELAY = cfg.crankDelayEpochs ?? 60 // 30 minutes at 30 s per epoch
// The most one message may cost (gas x maxFeePerGas). Fee data comes from the endpoint; without a ceiling a broken or
// hostile endpoint could spend the whole wallet on one call.
const MAX_FEE = parseEther(String(cfg.crankMaxFeeFil ?? '0.1'))
const RECEIPT_TIMEOUT_MS = 480_000
const chain = { id: cfg.chainId, name: cfg.network, nativeCurrency: { name: 'FIL', symbol: 'FIL', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } }
const pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) })
const key = process.env.CRANK_KEY && (process.env.CRANK_KEY.trim().startsWith('0x') ? process.env.CRANK_KEY.trim() : '0x' + process.env.CRANK_KEY.trim())
const account = key ? privateKeyToAccount(key) : null
// The key must be the configured backup cranker wallet: a secret pasted under the wrong name is caught here, not on chain.
const expected = cfg.wallets?.['cranker (watchtower backup)']
if (account && account.address.toLowerCase() !== expected?.toLowerCase()) throw new Error(`CRANK_KEY is the key of ${account.address}, not of the configured cranker ${expected}`)
const wallet = account ? createWalletClient({ account, chain, transport: http(cfg.rpcUrl) }) : null

// Refuse an endpoint on another chain: the SRA and SWA have the same addresses on calibnet and mainnet.
const reported = await pub.getChainId()
if (reported !== cfg.chainId) throw new Error(`the endpoint reports chain ${reported}, but ${cfg.network} is chain ${cfg.chainId}`)

// The revert data sits somewhere down viem's error chain; decode it with the contracts' ABI, else keep viem's words.
const revertReason = (err) => { for (let e = err; e; e = e.cause) if (typeof e.data === 'string' && e.data.startsWith('0x') && e.data.length > 2) return decodeRevert(e.data); return err.shortMessage ?? err.message }

const head = Number(await pub.getBlockNumber())
const word = async (address, slot) => BigInt(await pub.getStorageAt({ address, slot }))
// SRA: SraStorageQuarter at QUARTER_SLOT, lastSubmittedQuarter in the low 8 bytes (SraStorage.sol).
const lastSubmitted = Number((await word(cfg.sra, '0x347e624280399e1e720d839edbd7cd00c80c69bf34cd8ee59e27f691732af300')) & 0xffffffffffffffffn)
// SWA: GateParamsInfo at GATE_PARAMS_SLOT: lastCheckedQuarter, then target.base, target.stepRatio, steps (GateParams.sol).
const GATE = 0xf9abab00248d945495524c8caf6be2b837274c1becd1964fb3775f62fd6e4600n
const lastChecked = Number((await word(cfg.swa, '0x' + GATE.toString(16))) & 0xffffffffffffffffn)
const steps = Number((await word(cfg.swa, '0x' + (GATE + 3n).toString(16))) & 0xffffffffffffffffn)
const { quarter: q, latestBound, due: calls } = dueCalls(cfg, { head, lastSubmitted, lastChecked, steps })
console.log(`${cfg.network} epoch ${head} (quarter ${q ?? 'before activation'}) · latest bound ${latestBound ?? '-'} · lastSubmittedQuarter ${lastSubmitted} · gate lastCheckedQuarter ${lastChecked}, steps ${steps} · ${account ? 'key ' + account.address : 'DRY RUN, no key'}`)
const due = calls.map((c) => ({ ...c, to: c.name === 'submitShares' ? cfg.sra : cfg.swa }))
if (!due.length) console.log('nothing due')

const failures = []
for (const call of due) {
  try {
    const data = encodeFunctionData({ abi, functionName: call.name, args: call.args })
    try { await pub.call({ to: call.to, data, account: account?.address }) } catch (err) { console.log(`${call.key}: not possible now (${revertReason(err)})`); continue }
    const waited = head - call.since
    if (waited < DELAY) { console.log(`${call.key}: possible since epoch ${call.since}, waiting for the primary cranker (${DELAY - waited} epochs left)`); continue }
    if (!wallet) { console.log(`${call.key}: would send now (dry run)`); continue }

    const gas = (await pub.estimateGas({ account, to: call.to, data })) * 14n / 10n
    const fees = await pub.estimateFeesPerGas()
    const maxCost = gas * fees.maxFeePerGas
    if (maxCost > MAX_FEE) {
      const msg = `held back: could cost up to ${formatEther(maxCost)} FIL, above the ${formatEther(MAX_FEE)} FIL cap (crankMaxFeeFil); the next run tries again`
      console.log(`${call.key}: ${msg}`)
      await alert({ severity: 'warn', title: `backup cranker: ${call.key} held back by the fee cap`, text: msg }, cfg)
      continue
    }
    const hash = await wallet.sendTransaction({ to: call.to, data, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas })
    console.log(`${call.key}: sent ${hash}`)
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
    console.log(`${call.key}: ${receipt.status} in block ${receipt.blockNumber}`)
    if (receipt.status !== 'success') throw new Error(`${hash} reverted on chain in block ${receipt.blockNumber} after a passing simulation`)
    await alert({ severity: 'warn', title: `backup cranker sent ${call.key}`, text: `the primary cranker had not sent it ${DELAY} epochs after binding · ${hash}` }, cfg)
  } catch (err) {
    failures.push(call.key)
    console.error(`${call.key}: FAILED ${err.shortMessage ?? err.message}`)
    await alert({ severity: 'critical', title: `backup cranker: ${call.key} failed`, text: String(err.shortMessage ?? err.message).slice(0, 300) }, cfg)
  }
}
if (failures.length) process.exitCode = 1
