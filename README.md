# Solstice watchtower

Reads what landed on chain in f02, the SWA and the SRA (FIP-0118), records it, alerts on what did not land, and runs a
backup cranker and Claim keeper. Maintained by FIDL ([fidlabs](https://github.com/fidlabs)); forked from
[irenegia/solstice-watchtower](https://github.com/irenegia/solstice-watchtower), a proof of concept written by an AI
agent under Irene's direction. Treat decoded values as unverified until checked against an explorer: every record keeps
its raw data and message id for that.

- Page: `site/index.html`, a static file that reads the record from this repository and f02 live from the public
  endpoint. Being re-hosted at watchtower.fidl.tech; the original is at https://solsticewatchtower.eth.limo/.
- Design history and decisions: [DESIGN.md](DESIGN.md). How each FIP-0118 action can be observed on chain:
  [OBSERVABILITY.md](OBSERVABILITY.md). Scope: https://github.com/filecoin-project/solstice/issues/69

A scheduled workflow (`.github/workflows/read.yml`, every 10 minutes, plus an outside timer) has two jobs:

- **read** (can push, holds no key): the reader appends what landed to `site/data/<network>/records.jsonl` and commits
  it; `bin/watch.js` then checks the chain for overdue calls and alerts (`submitShares(q)` not landed
  `absenceAlertHours` after binding, critical past the backup delay or in the last week of the window; the gate check
  after `gateAlertHours`). Mainnet and calibnet are separate steps: one failing never skips the other.
- **backup** (holds the keys, cannot push, environment `production`): the backup cranker (`bin/crank.js`) sends
  `submitShares(q)` / `quarterlyGateCheck()` once the quarter has been bound for `crankDelayEpochs` (one day on mainnet)
  and nobody sent it, so the primary cranker (https://github.com/fidlabs/solstice-cranker) goes first. The Claim keeper
  (`bin/claim.js`) claims every owed wallet when nobody has claimed the stream for `claimEveryHours`. Both cap their
  fees, and neither keeps state between runs: the delay is measured from the binding epoch, the Claim interval from the
  record. Keys: `CRANK_KEY_MAINNET`, `CLAIM_KEY_MAINNET` (and `CRANK_KEY`, `CLAIM_KEY` for calibnet); without them, dry
  runs.

Quarter numbers are FIP-0118 §2.2's, as in the FIP, the fpv-indexer and the record: quarter Q starts at
`activationEpoch + (Q-1) * epochsPerQuarter`, and quarter Q's activity settles inside quarter Q+1 (posting,
verification, binding, then `submitShares(Q)`). The SRA's calls and events carry the same Q; only its internal index
(`_quarterOf`) counts from 0 at activation. What the backup sends, and when, is computed from the SRA's own schedule
(`lib/chain.js`).

**Email alerts**: [`alerts-service/`](alerts-service/README.md) is a small container (for DigitalOcean) that runs the
sign-up (double opt-in) and mails subscribers. With the variable `ALERT_SERVICE_URL` and the secret
`ALERT_SERVICE_TOKEN` set, it gets: the absence alerts, failed SRA/SWA/f02 messages, contract upgrades and owner
changes, gaps in the record, Claim checks that do not match, and backup-sender sends and failures, all mainnet only and
throttled per alert. `bin/watch.js` also sends a heartbeat each run, so the watchtower itself going quiet for three
hours is an email. Set `ALERTS_URL` in `site/index.html` to show the sign-up form on the page, and the variable
`WATCHTOWER_PAGE_URL` so emails link to the hosted page.

Needs Node.js 22 or newer.

| Command | What it does |
|---|---|
| `npm ci` | Installs the three libraries (`viem`, `iso-filecoin`, `@ipld/dag-cbor`). Once. |
| `npm run read` | One run of the reader against calibnet. Only reads from the public RPC endpoint. Appends to `site/data/calibnet/records.jsonl`. |
| `node bin/watch.js config/mainnet.json` | The absence check, once. Writes `site/data/mainnet/alerts.json`. |
| `node bin/crank.js config/mainnet.json` / `node bin/claim.js config/mainnet.json` | The backup cranker / Claim keeper, once. Without a key, a dry run that sends nothing. |
| `node bin/newkey.js mainnet <file>` | A new f1 key for the Claim keeper, written to a 0600 file; prints only the address. |
| `npm run page` | Serves the page at http://localhost:8000. Stop with Ctrl+C. |
| `npm test` | Decoder and decision tests on hand-written inputs. No chain data. |

Contract addresses, geometry and the activation epoch in `config/*.json` come from solstice `deployments.json`.
