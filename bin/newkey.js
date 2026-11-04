#!/usr/bin/env node
// Writes a fresh f1 (secp256k1) account for the Claim keeper to a file only you can read, and prints only the address.
//   node bin/newkey.js mainnet ~/.solstice/watchtower-claim-mainnet.key
// Then: gh secret set CLAIM_KEY_MAINNET --env production --repo fidlabs/solstice-watchtower < that file
// The key is never printed: terminals get screen-shared, recorded and scrolled back through.
import { writeFileSync, existsSync } from 'node:fs'
import { create } from 'iso-filecoin/wallet'
const [net, out] = process.argv.slice(2)
if (!['mainnet', 'testnet'].includes(net) || !out) { console.error('usage: node bin/newkey.js mainnet|testnet <key file>'); process.exit(1) }
if (existsSync(out)) { console.error(`${out} exists; refusing to overwrite a key`); process.exit(1) }
const a = create('SECP256K1', net)
writeFileSync(out, Buffer.from(a.privateKey).toString('hex') + '\n', { mode: 0o600 })
console.log(`address    ${a.address.toString()}`)
console.log(`key file   ${out}`)
