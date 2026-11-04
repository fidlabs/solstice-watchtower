# Solstice watchtower (PoC)

Reads what landed on chain in f02, the SWA and the SRA (FIP-0118) and shows it on one page.

> **Disclaimer: this is a vibe-coded PoC.** All the code, and OBSERVABILITY.md, were written by an AI agent
> (Claude Code). Irene directed the scope and the design. William (wjmelements) looked at it on 2026-09-19 and opened
> issue #1; nobody has done a full code review. Treat what the page shows as unverified until someone checks it. What
> has been checked: 12 automated tests on hand-written samples, two records compared by hand with a block explorer, and
> one day of butterflynet test data (2026-09-21) compared with the test plan of the person who ran it (see DESIGN.md).

- Live page, hosted on Filecoin (Filecoin Pin), stable address through ENS: **https://solsticewatchtower.eth.limo/**
  Views: mainnet (default since 2026-10-16), `?data=calibnet`. The butterfly gamma view was removed on 2026-10-16 (its network is gone; the record stays in `site/data/butterfly-gamma/`). The ENS name `solsticewatchtower.eth` points to the
  current version's CID and is updated at each publish; the data stays fresh because the page fetches the record from
  this repo (`site/data/`).
- Older versions, fixed to their CID (they keep working, but show only what their view list had):

  | Published | Link | Views |
  |---|---|---|
  | 2026-10-08 | https://inbrowser.link/ipfs/bafybeidkctdb4tvrzaxo4frph2bljl5mnnizwvciziakfxlaxt7jbsjsqu/ | calibnet (default), mainnet, butterfly gamma; pending governance tasks list, gate line |
  | 2026-09-30 | https://inbrowser.link/ipfs/bafybeihynojfvudvqsjisgqvlkhcx2fw7my4he4k6qdv5z6sjgjjayxpzm/ | calibnet (default), mainnet, butterfly gamma; gate line, "failed" label |
  | 2026-09-28 (afternoon) | https://inbrowser.link/ipfs/bafybeicy5n4zdzhnycdjktlscdxxapziqdhkvq5fyuzhztwcxpxgivya5u/ | calibnet, mainnet, butterfly gamma, with the "At a glance" block |
  | 2026-09-28 (morning) | https://inbrowser.link/ipfs/bafybeicjzly5sefxz7nyhhregr3yqfojvqusaukfvegmeqz3tc5iu527nu/ | the same |
  | 2026-09-23 (second) | https://inbrowser.link/ipfs/bafybeiemqoau7laiv2dsd62oud5ir5ufzapa2gm3g3rbfgbots43traeti/ | calibnet, mainnet, butterfly gamma |
  | 2026-09-23 (first) | https://inbrowser.link/ipfs/bafybeihrtha7j3z65six4cos4ozvhi35ijiir6o4s75zengtqji5ur4ftq/ | calibnet (first deployment, 2026-09-17), butterfly gamma, butterfly alpha |
  | 2026-09-20 | https://inbrowser.link/ipfs/bafybeihk4odsbmor5dbsjtt5uk4d3yl6z4hi3nadjqtzdpqrqlp25uylye/ | the same, plus the sample and real-test views |
  | 2026-09-18 | https://inbrowser.link/ipfs/bafybeiaalkk7ullf4rrllipm3wuvry7ebv7yuzwmecmplz4iqap2th5edi/ | calibnet (first deployment), sample, real test |

  The butterfly alpha record now lives in `archive/butterfly-alpha/`; the first calibnet deployment's record in
  `site/data/calibnet-2026-09-17/` (frozen, shown at the bottom of the calibnet history).
- Scope and discussion: https://github.com/filecoin-project/solstice/issues/69
- Design and its decisions: [DESIGN.md](DESIGN.md)
- How each FIP-0118 action can be observed on chain, by anyone: [OBSERVABILITY.md](OBSERVABILITY.md)

![The page with SAMPLE data, 2026-09-17](screenshots/sample-view.png)

*The page with SAMPLE data, written by hand to test it. Nothing in this screenshot happened on chain. The SRA and
the SWA were deployed on calibnet on 2026-09-17 and redeployed on 2026-09-22; the network upgrade that activates FIP-0118 there is on
Mon 2026-09-28 13:00 UTC. Until then the real record holds the deployment events and the reads, and f02 has no queue. The
"sample" and "real test" views were removed from the page on 2026-09-22; the real views are calibnet and the two butterflynet test networks.*

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

Quarter numbers everywhere follow the SRA (what executes): quarter q starts at `activationEpoch + q * epochsPerQuarter`,
and quarter q's cycle -- posting, verification, binding, `submitShares(q)` -- runs at its start. FIP-0118 §2.2 numbers
the same span q+1. Records written before 2026-11 carry a `quarter` field in FIP numbering; the page recomputes the
quarter from each record's epoch.

Needs Node.js 22 or newer.

| Command | What it does |
|---|---|
| `npm ci` | Installs the three libraries (`viem`, `iso-filecoin`, `@ipld/dag-cbor`). Once. |
| `npm run read` | One run of the reader against calibnet. Only reads from the public RPC endpoint. Appends to `site/data/calibnet/records.jsonl`. |
| `npm run sample` | Writes a SAMPLE record to `site/data/sample/` for local development (`?data=sample` is no longer linked from the page). |
| `npm run page` | Serves the page at http://localhost:8000 (sample view: http://localhost:8000/?data=sample). Stop with Ctrl+C. |
| `npm test` | Runs the decoder tests on hand-written sample inputs. |

The contract addresses and the activation epoch in `config/calibnet.json` come from solstice `deployments.json`.
