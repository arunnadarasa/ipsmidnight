# Clearer contract deploy UX (match the Deploy page)

Today the Anchor contract panel shows two badges, a sentence, and a raw runner log tail — so a five-minute "Preparing on the runner…" looks like nothing is happening. The Deploy page already solves this with a progressive step timeline; reuse it here.

## What you'll see

The Anchor contract panel gets the same timeline treatment, with an elapsed timer and the active step spinning:

```text
Anchor contract                             01:42 elapsed
  [x] Runner machine started                 started
  [>] Installing Node + Midnight SDK         first install, ~3 min
  [ ] Compact artifacts staged
  [ ] Toolchain ready
```

Then, on deploy:

```text
  [x] Toolchain ready
  [x] Wallet synced to the chain tip
  [>] Proving initial contract state         30-120s
  [ ] Contract deployed
```

And for a per-anchor submit/verify (same panel row area):

```text
  [x] Commitment prepared
  [>] Proving the anchor transaction
  [ ] Submitted to the ledger
  [ ] Confirmed in a block
```

Details:
- Four step states, identical to the Deploy page: pending (dim), active (spinner), done (check), failed (red with the error detail plus Copy error).
- Progress bar and "2 of 4 steps complete" summary line above the steps.
- When a job finishes green the timeline collapses into one row ("Toolchain ready in 3m 12s" / "Contract deployed in 1m 48s") with a Show steps toggle.
- The raw runner log moves behind a "Show runner log" disclosure, collapsed by default, so the terminal block is available but no longer the main thing on screen.
- Deployed state keeps the contract address and deploy tx rows as they are today.
- Mobile: single column, wrapped labels, existing truncated-mono treatment for addresses — nothing scrolls sideways.

## How it works

- New `src/lib/runner-steps.ts`: pure functions that map a runner job (`kind`, `running`, `log`, `result`) plus runner status (`machine`, `ready`, `current`, `contract`) into an ordered `StackStep[]` — the same type the Deploy page timeline already consumes. Step advancement is driven by markers already present in the log stream (`installing the Midnight toolchain`, `BOOTSTRAP_OK`, `waiting for stack…`, `[wallet]` sync lines, `deploying IpsAnchorRegistry`, `DEPLOY_OK`, `anchoring commitment`, `ANCHOR_OK`) and by the job's terminal result.
- To make the phases unambiguous rather than guessed from prose, the runner job scripts in `src/lib/midnight/runner.server.ts` get plain `echo STEP:<name>` progress lines between the existing commands. No change to what the jobs actually do.
- `src/components/deploy/ContractLifecycle.tsx` renders the existing `StackTimeline` component with those derived steps, keeps the Prepare/Deploy buttons, and wraps `LogTail` in a collapsed disclosure. When no job is running it shows the resting state (runner + toolchain + contract steps) so the panel always reads as a checklist.
- The `useAnchorSubmission` hook already polls the same job endpoint, so the anchors list can render a compact version of the same timeline for the active row.
- No database, schema, or provisioning behaviour changes; polling intervals stay as they are.
