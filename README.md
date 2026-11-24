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
  On mainnet, `bin/fees.js` then recomputes the FIP-0118 FIL price (Section 2.3) from every Filecoin Pay fee-auction
  claim, for each admitted stablecoin (USDFC and axlUSDC), and keeps it in `site/data/mainnet/fees.json`. See
  [Fee-auction alerts](#fee-auction-alerts).
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

### Fee-auction alerts

FIP-0118 values FIL settled on a bound payer/operator pair at the rate implied by Filecoin Pay's fee auctions: a claim
pays `msg.value` FIL for a lot of an admitted stablecoin, and the first five claims of at least `MIN_LOT` seed a median
reference; after that a claim prices only within `PRICE_BAND` (30%) of the last qualifying one. The auction's price is
per claim, not per dollar, and the buyer picks both the lot and the FIL paid, so a claim can print far from market. On
mainnet three of the five seed claims came from the axlUSDC auction and the reference has been about $1,500/FIL since
2026-11-11. `bin/fees.js` alerts on:

| Severity                    | When                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| info, Slack only            | every claim: token, lot, FIL paid, implied $/FIL, and whether it seeds, qualifies, is outside the band or is dust                                                       |
| warn                        | a claim that leaves part of the pot, pays more than `overpayPercent` above the auction price, or comes from a wallet not in `knownClaimers`                             |
| warn, weekly while it holds | the reference is outside `filUsdSane`; a pot is at least `potAlertUsd` (with what taking it costs); the two auctions' last claims are more than `divergenceRatio` apart |
| warn                        | a binding whose payer is its own operator; a FIL rail opened on a bound pair, or found on a pair when it is bound                                                       |
| warn (email)                | `AdmittedListsUpdated` or `PricingParamsUpdated` from the SRA: the pricing inputs change from the next quarter                                                          |
| critical                    | FIL settled on a bound pair (`RailSettled`, `RailOneTimePaymentProcessed`), with its value at the current reference                                                     |

Claims are found by tracing (`trace_block`), because `burnForFees` emits no event and a claim inside a multicall
carries its FIL in an internal call. The node keeps traces for 14 days, so `fees.json` was seeded with the quarter-1
claims before epoch 6540000 from transactions decoded on Blockscout; if the job stops for longer than that, a critical
alert names the epochs it could not read. `MIN_LOT` from quarter 2 depends on quarter 1's bound volume, which is not
computed yet: from quarter 2 claims are marked provisional and use `MIN_LOT_FLOOR`.

Needs Node.js 22 or newer.

| Command                                                                           | What it does                                                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                                                          | Installs the three libraries (`viem`, `iso-filecoin`, `@ipld/dag-cbor`). Once.                                                  |
| `npm run read`                                                                    | One run of the reader against calibnet. Only reads from the public RPC endpoint. Appends to `site/data/calibnet/records.jsonl`. |
| `node bin/watch.js config/mainnet.json`                                           | The absence check, once. Writes `site/data/mainnet/alerts.json`.                                                                |
| `node bin/fees.js config/mainnet.json`                                            | The fee-auction check, once. Writes `site/data/mainnet/fees.json`. `FEES_MAX_EPOCHS` raises the 2,880 epochs read per run.      |
| `node bin/crank.js config/mainnet.json` / `node bin/claim.js config/mainnet.json` | The backup cranker / Claim keeper, once. Without a key, a dry run that sends nothing.                                           |
| `node bin/newkey.js mainnet <file>`                                               | A new f1 key for the Claim keeper, written to a 0600 file; prints only the address.                                             |
| `npm run page`                                                                    | Serves the page at http://localhost:8000. Stop with Ctrl+C.                                                                     |
| `npm test`                                                                        | Decoder and decision tests on hand-written inputs. No chain data.                                                               |

Contract addresses, geometry and the activation epoch in `config/*.json` come from solstice `deployments.json`.
