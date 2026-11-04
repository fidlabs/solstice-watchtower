# Solstice watchtower PoC: design

Approved by Irene 2026-09-17. Scope issue: https://github.com/filecoin-project/solstice/issues/69

## What it is

A reader runs every 10 minutes against calibnet and appends what it finds to a public record.
One page shows that record in three parts:

1. Queued writes: every write waiting in the f02 pending-write queue, with its decoded payload,
   its effective epoch and the time left.
2. What landed: events and messages of f02, the SWA and the SRA, in time order, grouped by quarter.
3. State: values that leave no event, read on every run.

Not in the PoC: the alert, any automatic judgment, the miner actor / f07 / f06 / f05 checks, mainnet,
anything off chain.

## The reader (`bin/reader.js`)

One run:

1. Reads the last epoch it finished from `status.json`.
2. For the new epochs it fetches
   - the f02 actor events (`Filecoin.GetActorEventsRaw`),
   - the SRA and SWA logs (`eth_getLogs`),
   - every message to the SRA or the SWA, sent directly or through any Safe, with its result (until
     2026-09-30 only the four owner Safes were followed). A reverted
     message emits no event (FIP-0118 §2.4.9: "Reverted calls emit no event"), so messages are found by
     reading every block. The revert reason comes from the on-chain receipt; only the inner call of a multisig
     message is replayed. A message that used all its gas is recorded as "out of gas" plus the replay's reason.
     Messages sent to f02 itself are read too, from the activation epoch on.
3. At the chain head it does the reads: f02 state, the state behind `streams_root`, wallet balances, SRA views.
   For every `claim-payout` event it also reads the recipient's balance just before and just after.
4. For every queued write it has seen (from a `write-queued` event or from the queue in the f02 state), once the
   effective epoch E has passed it reads the f02 state at tipset E+1 (and E+2) and records a `queued write outcome`:
   `applied`, `dropped or replaced`, or `still queued`. f02 writes no visible event at that moment, so this read is
   the only evidence (added 2026-09-19, after rvagg's rule: poll the state at every effective epoch). Tested on
   hand-written samples only; the first real test is butterfly gamma on 2026-09-21.
5. Appends the new records to `records.jsonl` and moves the cursor.

Rules for the record:

- Append-only. A line is never rewritten, so the file history shows what was seen and when.
- Every decoded value keeps its raw data and its message id next to it, so the decoding can be checked
  against a block explorer.
- A read is recorded only when its value changed since the last run.
- What the decoder does not know is recorded as `unknown(...)` or `undecoded` with the raw data. Nothing is dropped.

Quarter numbers follow FIP-0118 §2.2: `Start(Q) = ACTIVATION_EPOCH + (Q-1) * EPOCHS_PER_QUARTER`,
quarter Q is `[Start(Q), Start(Q+1))`. Quarter 0 means before activation.

## Sources the decoders were written from

- Contracts: solstice `main` at `87fd57c` (2026-09-16), re-checked at `0fa8cca` (2026-09-17, the first calibnet
  deploy, now frozen) and at `0006edc` (2026-09-22, the calibnet v1 redeploy, solstice #83; adds `GateParamsSet`
  and `WeightRecordsQueued` from PR #79, `InvalidActorId` from PR #78, and `replaceWallet` / `removeOrchestrator`
  reverting on an f02 refusal from PR #80). Every error and event of the SRA, SWA and FVMRewards at `0006edc` is in
  `lib/evm.js` (checked 2026-09-23). Each signature group names its file.
- f02 events and state: FIP-0118 §2.4.2 and §2.4.9 at the PR #1286 head `a1a0a8b`, checked against
  builtin-actors `master` at `eb9c308`, `actors/reward/src/emit.rs` (PR #1782 merged 2026-09-16).

When a contract or f02 changes, re-read these and update `lib/evm.js` / `site/lib/f02.js`. The f02 decoder
lives inside `site/` because the page uses the same file for its live read.

## The page (`site/index.html`)

One static file, no framework, relative paths only, so the folder works when served from a Filecoin CID.
It displays `data/<network>/records.jsonl` and `status.json`, and reads f02 live (below). Times are UTC
because the rehearsal plan uses UTC. The plan's "Q5 cycle" runs on the day after Q5 ends, so on chain it falls
in quarter 6: each quarter header shows both labels.

The queue is taken from the f02 state and rebuilt from the `write-*` events as a cross-check. If the two
differ, the page says so.

### Live read of f02 (decided 2026-09-18, in from the first live version so the rehearsal tests it)

Parts 1 (queued writes) and 3 (state) do not wait for the scheduled job. When the page opens, the visitor's
browser asks the public endpoint for the f02 state (`Filecoin.StateReadState`, then `Filecoin.ChainReadObj`
for the block behind `streams_root`) and decodes it with the same layout as `lib/f02.js`. The endpoint allows
calls from a web page (`access-control-allow-origin: *`, checked 2026-09-18 on the calibnet endpoint).

- Why: the record can be 15 to 20 minutes old. On calibnet the hold is 6 hours, on butterfly 20 minutes; a
  queued write must show at once, with the right time left.
- The page shows both: the live queue, and the queue from the record with its age. If they disagree by more
  than the record's age explains, the page says so. Two sources that should agree are a check on each other.
- If the endpoint does not answer, the page says so and shows the recorded values only. It never shows stale
  values as live.
- Part 2 (what landed: history, failed messages, proposal contents) always comes from the record: a browser
  can only ask the chain about now.
- Cost: the page loads one small CBOR library, and each visitor sends a few requests to the public endpoint.

## Testing

- `npm test`: hand-written SAMPLE inputs through the real decoders. No chain data.
- `npm run sample`: a SAMPLE record for the page (`?data=sample`), kept apart from the real record.
- `config/plumbing-check.json`: the reader pointed at a busy existing calibnet contract, to test logs,
  messages and revert reasons on real data before the SRA and SWA exist. Its output (one run, 2026-09-17,
  epoch 4077698, 128 records, 11 reverted) is the page's third view, `?data=real-test`. One reverted record
  was checked by hand against Filfox on 2026-09-17: same epoch, status `SysErrContractReverted`.
  Correction 2026-09-18: the first version of the reader got the reason by replaying the call, and the replay
  left out the message's `value`, so it reported a wrong reason (`Error(Incorrect fee amount)`). The reader now
  takes the reason from the on-chain receipt (`Filecoin.StateSearchMsg`, field `Return`) and replays only the
  inner call of a multisig message. The 11 reverted records of this view were re-read from their receipts:
  custom error `0x9514f828`, which this decoder does not know because the contract is unrelated.
- First real records, 2026-09-18: the reader was run on the deployed calibnet SRA and SWA from their
  deployment blocks (SRA 4078418, SWA 4078422). It decoded `Upgraded`, `OwnerAdded` (twice), `Initialized` and,
  for the SRA, `OrchestratorAdmitted` with the identity and wallet of `deployments.json`. The SRA deployment
  message was checked by hand on Filfox: height 4078418, status OK, method `CreateExternal`.
- First real f02 data, 2026-09-18: the reader was run once over butterflynet "alpha" (lotus-infra issue #1654;
  genesis 2026-09-17 20:04 UTC, FIP-0118 active from epoch 90, rvagg's test run; overwritten by a reset the same
  evening), with the ok of BigLep (lotus-infra PR #1655). 318 records, kept in `site/data/butterfly-alpha/` as
  the only copy, shown as the page's view `?data=butterfly-alpha`. What it proved on real data: the decoding of
  the state behind `streams_root` (three streams, share maps, accrued amounts); messages sent to f02 itself
  (7 `Claim`, 3 `SetShares`, 1 `ReplaceAddress`); the two-multisig pattern (`Submitted`, `Approved`, `Rejected`);
  a real f02 rejection (`quarterlyGateCheck` failed with `StepWeightRecordsFailed(16)` at epoch 2563, passed
  at 2616 after a stream was removed). Three hand checks inside the record agreed: the service stream's weight
  (35%, t_start 2400) against the gate check of quarter 10 (steps 5); `SharesSubmitted` for quarter 10 (1
  recipient, 250,000 USD) against the share map (1 row) and against `VolumePosted`; `aggregatedFilecoinPayVolume(10)`
  read as 250,000 USD. Not proved there: f02 events (the actor events API was off on that node; it is on from
  the next reset), and nothing could be compared with a block explorer (butterflynet has none).
- First full day on real data, 2026-09-21, butterflynet "gamma" (FIP-0118 active from epoch 5221, 2-hour
  quarters, 40-epoch hold; rvagg's nv29 test run, plan in his handoff files, kept privately). The job was started
  by hand every 15 to 25 minutes from 04:41 to 12:20 UTC, then left to its schedule. Everything recorded matched
  the plan, epoch by epoch: `postVolume` and `correctVolume` (one second approval reverting
  `NotInVerificationWindow(3)`, then a `veto`), `submitShares` (one reverting `SetSharesFailed(17)` after an
  Orchestrator was admitted with a wallet f02 refuses, then the two-owner `replaceWallet` and `removeOrchestrator`
  repair), a `Claim` with its `claim-payout` (the claim check matched the wallet balance change exactly), three
  passed gate checks. Each gate step gave a `write-queued` event and the same entry in the f02 queue, showed on
  the published page live with its time left, and got a `queued write outcome: applied` line read at E+1, with
  the new weight in the state. Three share maps were checked by hand against the posted volumes. No gap record.
  One lesson: the record ends `LAG` (5) epochs behind the chain head, so "not seen" must always come with "record
  up to epoch N". Calibnet the same day: the first two governance actions (`setAdmittedLists`, `setPricingParams`),
  each sent through both owner multisigs, decoded with `via: sraOwnerN` and the `Submitted` / `Approved` /
  `...Updated` events.
- Rest of the gamma run, 2026-09-21 12:20 UTC to 2026-09-22 04:44 UTC (epochs 6155 to 8128), checked on 2026-09-23
  against rvagg's update 1 (rows S-1 to S-12, S-6, G-13 to G-21; the discretionary writes he moved to the end of the
  run). Read by the timer, no gap. Every row he sent is in the record, at his epoch or a few later: the correction
  rows (a `VolumeCorrected` for an Orchestrator with no post in that quarter), the one-recipient `SharesSubmitted(5)`,
  two claims with matching claim checks (one with two wallets), pricing params and admitted lists by both owners,
  reassign / cancel / register of a binding, `addOrchestrator` and `removeOrchestrator` proposals vetoed, a
  `setGateParams` armed then vetoed with the gate check passing in between, the SRA upgrade (`upgradeToAndCall` by
  both owners, completion after the hold, `Upgraded`), three `replaceWallet`, the empty-quarter `submitShares(10)`
  with no event, `removeOrchestrator(orch2)`, `setDistribution` to the f1 writer and back to the SRA (both
  `applied`), `submitShares(11)` reverting `SetSharesFailed(18)` then the writer's f02 `SetShares`, and six gate
  steps each queued and `applied`. Also in the record, not in his table: the split retune (`setWeightRecords`
  applied, `setGateParams` half vetoed), an SWA `replaceOwner` (`OwnerRemoved`, `OwnerAdded`, `OwnerReplaced`),
  and a `setWeightRecords` cancelled by `cancelPendingWeight` (`write-cancelled`, first seen). rvagg's later bundle
  (v2, received 2026-09-23) re-slots the split retune to [7586, 7706] and notes the earlier omission was "caught by
  the watchtower"; the record has it inside that window. Not sent by him (the
  record has those epochs): S-7b and S-11a, two calls meant to revert, and S-4a, a self-send outside the watchtower's
  scope. New on real data here: the outcome read for `SetWeightRecords` and `SetDistribution`, `write-cancelled`,
  a contract upgrade with its hold, an owner rotation.
- Still not tested on real data: the `write-dropped` and `write-applied` events; a `dropped or replaced` outcome;
  the three f02 events added in builtin-actors v19.0.0 (`period-folded`, `shares-set`, `address-replaced`;
  PR #1794, 2026-09-22), decoded since 2026-09-22 but not yet seen. Calibnet activation (2026-09-28) is the first
  chance for these, if the calibnet Lotus release ships v19.0.0.

## Known limits of the PoC

What can be observed on chain, for every action, is in [OBSERVABILITY.md](OBSERVABILITY.md). These two limits
are in this code, not in the chain:

1. Fixed 2026-09-18: the reader now also reads messages sent to f02 itself (`Claim`, or a stream method called
   directly), from the activation epoch on. They are native Filecoin messages, so they are read with
   `Filecoin.ChainGetMessagesInTipset`, two more requests per epoch. Not yet tested on real data: calibnet's
   f02 gets these methods at activation (2026-09-23).
2. The reader must not stop for long. It finds messages by reading every block, and the public calibnet
   endpoint keeps full blocks for only 17 hours to 2 days (measured 2026-09-17: a block 2,000 epochs old was
   served, one 6,000 epochs old was not). Messages from a longer gap are lost. This matters most for
   `SetAdmittedLists` and `SetPricingParams`, whose event is the only record of the values. How long the
   endpoint keeps events was not measured; one `eth_getLogs` query may span at most 2,880 epochs there
   ("block range exceeds maximum of 2880", seen 2026-09-18).

## Changes for the next publish of the page (asked by Irene 2026-09-20)

1. Make it clear which network the visitor is looking at. Today the network is one word in the header line and
   the view links look all the same.
2. Remove the `sample` and `real-test` views once calibnet has real queued writes (after 2026-09-23).
3. Warn when stream 1's `t_start` in the f02 state differs from the configured `activationEpoch` (noted
   2026-09-21, not built). The migration sets `t_start` to the Lotus upgrade epoch + 1 (go-state-types
   `builtin/v19/migration/top.go` line 134 at `6c7f7c3`: `activationEpoch := priorEpoch + 1`), and the SRA
   counts quarters from its own `activationEpoch` (`deployments.json`). FIP-0118 §2.4.10 expects the two to be
   equal (`t_start` = `ACTIVATION_EPOCH`). On butterfly gamma they are (upgrade 5220, both 5221). On calibnet
   they are equal only if the Lotus upgrade epoch is 4094733; with 4094734 the f02 ramp and the SRA quarters
   are one epoch apart. Nothing breaks, but the page should say it.
4. In part 2 ("What landed"), show the newest row first, not last (asked by Irene 2026-09-21): newest quarter
   on top, and inside a quarter the newest event or message on top.

## Calibnet redeploy and mainnet (2026-09-23)

The calibnet SRA and SWA were redeployed on 2026-09-22 at new addresses (solstice PR #83 "deploy v1", William:
"we agreed it would be easier to redeploy the contracts"; `deployments.json` at `0006edc`), and the calibnet upgrade
moved to epoch 4109133, Mon 2026-09-28 12:59:30 UTC (BigLep's Slack post of 2026-09-22; Lotus PR #13809). A redeploy
carries nothing over: no owner action, no lists, no pricing params. The two `setAdmittedLists` and `setPricingParams`
of 2026-09-21 went to the old SRA and must be sent again on the new one.

Decisions (Irene, 2026-09-23):
- `config/calibnet.json` points to the new contracts, from epoch 4092521 (three before the new SRA deployment); the
  record of the first deployment is frozen in `site/data/calibnet-2026-09-17/` and the page shows it as the last group
  of the calibnet history, with a note. One calibnet view, not two.
- A `mainnet` view from day one: the same two addresses were deployed on mainnet on 2026-09-22 (SRA at epoch 6393228,
  SWA at 6393232); `deployments.json` carries `activationEpoch` 6450120, but the mainnet upgrade date is not confirmed
  (Irene, 2026-09-23), so the page names no date. It shows only the deployment events until the upgrade,
  and tests the mainnet path (endpoint, explorer links) before it matters.
- Butterfly gamma stays while rvagg's run lasts; butterfly alpha left the page (its record is in `archive/`). Older
  page versions stay reachable at their CIDs, listed in the README.
- Stable address: the ENS name `solsticewatchtower.eth` (registered by Irene 2026-09-22, Jennifer's suggestion),
  content hash set to the current CID at each publish; https://solsticewatchtower.eth.limo/ .
- The public endpoint capped `eth_getLogs` at 360 blocks in one answer on 2026-09-23 (2880 on 2026-09-18), so the
  reader now asks in chunks of 360.

## Changes in the reader after the 2026-09-21 test (no publish needed)

1. DONE 2026-09-22 (decoder and one test, real data not seen yet): decode the three new f02 events of builtin-actors v19.0.0 (`period-folded`: `stream-id`, `cause`, `accrued`,
   `dust`; `shares-set`: `stream-id`, `shares` rows; `address-replaced`: `stream-id`, `old-recipient`,
   `new-recipient`; `emit.rs` at `3662c66`). Today they are recorded by `$type` with raw entries, nothing is lost.
   `period-folded` matters most: it is the only way to see a fold and its dust per stream; today only the burn
   total is visible. All three come from explicit messages only, so a fold inside the block reward stays invisible.
2. DONE 2026-09-23: the f02 state read leaves out the four FIP-0118 counters that move with every block reward
   (`TotalMintedReward`, `TotalBurnMinted`, `TotalExplicitMinted`, `Accrued`), so a "f02 state" line means a real
   change (SWA actor, timelock, streams root). The counters stay readable live; the burn shows in the f099 balance.
3. DONE 2026-09-23: the parameters of `Claim`, `SetShares` and `ReplaceAddress` messages are decoded (`decodeF02Params`
   in `site/lib/f02.js`, from builtin-actors `types.rs` at `3662c66`); other methods keep the raw CBOR.
4. DONE 2026-09-23 for `fpvOf(q, orch)` (current and previous quarter, for every Orchestrator admitted in the record
   and not removed) and `bindingOf(payer, operator)` (every pair declared or reassigned in the record and not
   cancelled). `totalUsd[q]` has no public getter before binding (`aggregatedFilecoinPayVolume` reverts `NotBound`),
   so the current quarter's running total is not read; the bound value is, as before. Limit: an Orchestrator seated
   before the record starts (the migration's initial one, when the record starts after deployment) is known only
   through its `OrchestratorAdmitted` event at deployment, which the calibnet and mainnet records have.

## The backup cranker (`bin/crank.js`, 2026-10-08)

> **Changed 2026-11 (FIDL fork).** The notes below are the history. Now: the delay is measured from the quarter's
> binding epoch (no `crank.json`), only the latest bound quarter is tried, fees are capped (`crankMaxFeeFil`), the
> endpoint's chain id is checked, and a failure alerts and turns the run red. The Claim keeper claims when the record
> shows no Claim on the stream for `claimEveryHours` (no `claim.json`), in batches of at most 64, with a fee cap and a
> 10%-of-payout limit. Both run in a separate `backup` job that holds the keys and cannot push. Quarter numbers follow
> the SRA (quarter q starts at `activationEpoch + q * epochsPerQuarter`), not FIP-0118 §2.2.

Irene's ask: a second, independent cranker, so the two permissionless calls do not depend on one system.
A step of the read workflow runs it on calibnet after the readers:

- What it sends: `submitShares(q)` on the SRA for a bound quarter the SRA has not submitted
  (`lastSubmittedQuarter` from the SRA's `QUARTER_SLOT`), and `quarterlyGateCheck()` on the SWA when the
  quarter it reads (`lastCheckedQuarter + 1`, from `GATE_PARAMS_SLOT`) is bound and `steps < 8`.
- Simulate first: every call is tried with `eth_call`; a call that would revert is not sent (the reason is logged).
- Backup, not a race: a call is sent only when its simulation has passed for `crankDelayEpochs` (60 = 30 minutes),
  so the primary cranker (decentramike/solstice-cranker) has time to act. The first passing epoch is kept in
  `site/data/calibnet/crank.json`, committed with the record.
- The key: repository secret `CRANK_KEY`, a calibnet MetaMask account with tFIL and no other use; without it the
  step is a dry run. The run refuses a key whose address is not the configured `cranker (watchtower backup)` wallet.
- Mainnet (2026-10-15, Irene's decision): the cranker and the Claim keeper run for `config/mainnet.json` too, with
  their own secrets `CRANK_KEY_MAINNET` (f410) and `CLAIM_KEY_MAINNET` (f1), real FIL, and a one-day delay
  (`crankDelayEpochs` 2880) before a crank is sent. Dry runs until the secrets and the wallet addresses are in place.
- The daily `Claim` is a second step, `bin/claim.js` (2026-10-12): once a day it reads the f02 state, lists every
  wallet in a live stream's share map or payable rows and every tombstone's payable rows, simulates `Claim(id,
  wallets)` per stream with `Filecoin.StateCall`, and sends only a batch that would pay something. `Claim` is a native
  f02 message, so its key is a separate f1 account (repository secret `CLAIM_KEY`; the run checks that the key's
  address is the configured `claimer (watchtower backup)` wallet, after a secret mix-up on 2026-10-12). A backup: Claims
  are already sent on calibnet from another f1 address (t15gfg…), daily for A's wallet; the public solstice-cranker
  repo has no Claim step, so who sends them is not known here. State: `site/data/calibnet/claim.json`.
- Limit: both crankers run on GitHub Actions. They differ in code, key, operator and trigger, but a GitHub outage
  stops both; said to Phi-rjan for the operational setup.

## Later steps (not built)

1. Done 2026-09-18, again 2026-09-20 (adds the butterfly views): one manual publish of `site/` to Filecoin with
   the `publish` skill (mainnet only). Each publish gives a new link; the current one is in the README.
2. The scheduled job: GitHub Actions runs the reader every 10 minutes and commits the record to this repo
   (`.github/workflows/read.yml`; it holds no key and no secret, and starts running once it is on GitHub).
   Three rules for when it fails (decided 2026-09-18); a watchtower that stops silently is worse than none:
   - The page warns. If the newest read in the record is more than 30 minutes old, the header turns red:
     "The reader has not run since HH:MM UTC. The history below may be incomplete." The live read of f02
     keeps working, it does not depend on the job.
   - The job catches up by itself. Each run starts from the last epoch it finished and reads at most 720
     epochs (6 hours of chain), so one run heals a stop of up to 6 hours. The limit was 120 epochs until
     2026-09-18. That day GitHub started the job once in the first 5.5 hours (its scheduler is "best effort"),
     and with runs an hour or more apart a 1-hour limit meant the record fell further behind on every run.
   - A gap that cannot be healed is recorded, not hidden. If the endpoint no longer serves the blocks of the
     gap (limit 2 above), the job writes one record "epochs X to Y could not be read", and the page shows it
     in the history, so silence is never taken for "nothing happened".
   Telling a person that the job stopped is the alert, which is outside the PoC.
3. Hosting (decided 2026-09-17 and 2026-09-18): the website is served from IPFS/Filecoin through Filecoin
   Pin, not from GitHub Pages. The page is fixed and is re-published only when the page itself changes, so it
   has one stable link. When it opens, it fetches the record from this repo, where the scheduled job commits
   it; if the repo does not answer, it falls back to the record bundled at publish time. This is the shape of
   the PDP explorer (`pdp.filecoin.cloud`): fixed page files, data fetched by the browser on load (there from
   a Goldsky index; checked 2026-09-18 by listing the page's requests). Known delay: up to about 15 to 20
   minutes (10-minute schedule, GitHub starting scheduled jobs late, and a 5-minute cache on raw files,
   `cache-control: max-age=300`, measured 2026-09-18).
   Rejected for now: re-uploading the whole folder on every change and re-pointing a name (ENS or a domain)
   to the newest CID. It adds the upload time and the gateway lag to the delay, needs a name someone has to
   give us and two secrets in CI, and none of the team's explorers works that way. It stays the later option
   if the record itself must live on Filecoin; until then a daily snapshot of the record can be uploaded.
   Later improvement, same decision: a Goldsky subgraph for the SRA and SWA events, as the PDP explorer has,
   to shorten the delay for them. It cannot cover f02 (not a contract) or failed messages (no event).
4. The alert, in its simplest form, built 2026-09-24 (Irene's ask, after the question how to follow the rehearsal
   without polling): the job posts one Slack message per run that found something new on mainnet (calibnet lines were switched off on 2026-10-22, `"notify": false` in its config, after the rehearsal)
   (events, messages with their result, gaps, queued write outcomes, claim checks; routine reads left out; at most
   40 lines) to `#fil-solstice-watchtower` (first to `#fil-upgrade-filplus`, moved the same day to a channel of its own),
   through an Incoming WebHook created by TippyFlits (app `solstice-watchtower`, Irene is app collaborator). The URL is the repository secret `SLACK_WEBHOOK`; without it nothing is sent; a
   failed post never fails the run; butterflynet is opted out (`notify: false`). A manual start with `test_slack`
   posts one marked test line (`bin/slack-test.js`). No judgment: people compare the lines with the rehearsal
   plan's watchtower column and answer in the thread. Lesson from the same day: in a workflow file, `env` with
   `${{ }}` must be in block form; the inline `{ }` form is invalid YAML and stopped the job for two minutes.
5. A proper timer for the reader (decided 2026-09-21). GitHub starts the scheduled job only every 2 to 5 hours
   (measured 2026-09-18 to 2026-09-21). Stopgap for the PoC: an outside timer (cron-job.org) starts the job every
   15 minutes through the GitHub API, with a token limited to this repo and the Actions permission, held by
   Irene. To fix after the PoC, one of: (a) a timer on a FilOz machine, set up by infra, so the token is in team
   hands; (b) remove the need for a job for the contract events with an index like the PDP explorer's Goldsky
   subgraph. (b) cannot cover f02 or failed messages, so the reader stays for those.
