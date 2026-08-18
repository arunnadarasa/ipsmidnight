# One-click Compact contract deploy and anchoring

Today the Compact contract is deployed and anchors are submitted by running `scripts/deploy-midnight.mjs` and `scripts/anchor-midnight.mjs` by hand in a sandbox. This plan moves that into the console: a fourth "runner" machine inside the existing Midnight Fly app runs the same two scripts, and the UI gets real **Deploy contract** and **Submit anchor** buttons with a live log.

Nothing about the contract or the proving flow changes — the exact scripts that produced the live contract `b5ecda37…a2e2` are what the runner executes.

## Why a runner machine

The app's own server runtime is serverless: no persistent disk, no long-lived proof-server session, and it can't host a wallet or the LevelDB private-state store the Midnight SDK requires. The runner is a small always-on machine on the same Fly private network as the node, indexer, and proof server, with a volume that keeps the private state between runs. One shared private-state store is used for all anchors, matching the contract, which holds no per-user private state.

## What the user sees

On the Midnight page, the existing "Anchor contract" panel becomes a lifecycle panel:

```text
Runner                      ready · midnight-runner (2 vCPU / 2 GB)
Contract    IpsAnchorRegistry   deployed · b5ecda37…a2e2   [Redeploy]
Anchors     1 queued                                       [Submit anchor]

  proving… (14s)   ─ live log tail, expandable ─
```

- **Prepare runner** appears when the runner machine or its toolchain is missing; it creates the machine, installs the SDK, and reports progress in the existing StackTimeline style.
- **Deploy contract** is enabled once the runner is ready and the stack probes green. On success the panel shows the address, deploy tx, and block, and a "View anchors" hint.
- **Submit anchor** appears per queued anchor row (and as a "Submit all queued" action). On success the row flips to `anchored` with its tx and block, and the existing verify button confirms it against the indexer.
- Every run streams a log tail so a stall is visible, and a failed run shows the last error with a **Retry** action instead of a spinner that never ends.
- If `FLY_API_TOKEN` is missing or the stack isn't provisioned, the panel explains that instead of offering dead buttons — same graceful degradation as the rest of the page.

## Technical approach

### Runner machine

Added to `src/lib/midnight/fly.server.ts` alongside the node/indexer/proof specs:

- Name `midnight-runner`, image `node:22-bookworm-slim`, `init.cmd = ["sleep", "infinity"]`, no published services, `restart: always`, 2 vCPU / 2 GB.
- Volume `midnight_runner` mounted at `/work` — holds `node_modules`, the compiled contract, the scripts, the LevelDB private state, and run logs, so private state survives restarts.
- Reuses `machineBody` (so `fly_process_group` metadata is set) and is created by `provisionStack` and re-applied by `repairMidnightStack`, so existing "Repair" already fixes it.

### Getting the contract artifacts onto the runner

The compiled prover keys are megabytes, too large to push through the exec API. A private Storage bucket `midnight-artifacts` holds one tarball of `contracts/managed/ips-anchor-registry` plus the two scripts, uploaded once from the sandbox. Bootstrap runs through exec on the runner:

1. `curl` a short-lived signed URL for the tarball into `/work` and unpack it.
2. `npm install` the pinned Midnight SDK versions already listed in the header of `scripts/deploy-midnight.mjs`, plus `ws`.
3. Write `/work/.ready` with the artifact version so the UI can tell a stale runner from a fresh one and re-bootstrap when the contract is recompiled.

### Running a job without blocking

Fly's exec call is capped at ~25s, and proving takes minutes, so jobs are detached and polled:

- Start: exec `nohup node /work/scripts/<script>.mjs … --out /work/out/<jobId>.json > /work/logs/<jobId>.log 2>&1 &` — returns immediately.
- Poll: exec a `tail` of the log plus a `cat` of the result file. A result file means done; its contents carry the address/tx/block or the error.
- Both scripts get two small additions: `--out <file>` to write a JSON result, and `--project` pointed at `/work` (the deploy script already accepts `--project`; the anchor script already accepts `--store` and `--address`).

### Server functions and data

New `src/lib/midnight/runner.functions.ts` (thin wrappers, logic in `runner.server.ts`), all behind `requireSupabaseAuth` like the existing provisioning functions:

- `prepareRunner` — ensure machine, bootstrap toolchain, return readiness.
- `runnerStatus` — machine state, `.ready` marker, active job, log tail.
- `startContractDeploy` / `startAnchorSubmit` — launch a job, return a job id.
- `pollRunnerJob` — log tail plus result; on a finished deploy it records the contract row, on a finished anchor it updates the `midnight_anchors` row (`status`, `tx_hash`, `block_height`, `contract_address`) and writes an `activity_log` entry.

One migration adds `midnight_contracts` (user_id, address, deploy_tx, block_height, network, circuit, compact_version, deployed_at) with grants for `authenticated` + `service_role`, RLS enabled, and policies scoped to `auth.uid()` — the runtime can't write repo files, so the deployed address lives in the database. `src/routes/app.midnight.tsx` reads the DB row first and falls back to the bundled `src/data/midnight-contract.undeployed.json`, so the currently live contract keeps showing with no migration of existing state.

### UI

- `src/components/deploy/ContractLifecycle.tsx` — the new panel, built from the existing `StackTimeline`/`Panel` primitives and semantic tokens, mobile-first with the sticky-action and truncated-mono conventions already used on the page.
- `src/routes/app.midnight.tsx` — swaps the static "Anchor contract" panel for it and drops the "submit it with the deploy script" toast copy.
- Job polling uses `useQuery` with a short interval while a job is active, stopping when it finishes.

### Scope notes

- The sandbox scripts stay in the repo and keep working unchanged — the runner is an additional path, not a replacement, so the manual escape hatch remains.
- Deploy actions are limited to signed-in users, consistent with existing Fly provisioning. If you want them restricted to an admin role instead, say so and I'll gate them with `has_role`.
