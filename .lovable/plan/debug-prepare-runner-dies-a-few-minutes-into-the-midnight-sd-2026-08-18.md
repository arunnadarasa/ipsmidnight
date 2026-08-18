# Debug: "Prepare runner" dies a few minutes into the Midnight SDK install

## What the screenshots show

The timeline reaches **Installing the Midnight SDK** (step 3 of 4), the elapsed
timer keeps counting, and nothing ever completes or fails. Two separate runs
(07:39, 07:42, 07:50 in Activity) each restarted the same bootstrap job, which
means the previous one never wrote a result.

That shape — spinner forever, no error — happens when the job's process
disappears without writing its result file. The poller reports `pid gone` plus
`result: null`, and the current step mapper leaves the step `active` rather than
`failed`, so the UI cannot tell "still working" from "died".

The most likely cause of the process disappearing during `npm install` of the
Midnight SDK is resource exhaustion on the runner machine: it is a 2 vCPU /
2048 MB machine with a 5 GB volume, and the SDK set (compact-js, zswap,
testkit-js, wallet-sdk, plus WASM payloads) is heavy to unpack. A Fly OOM kill
takes the whole machine down, and `restart: { policy: "always" }` brings it back
up clean — which is exactly "it stops after a few minutes" with no message.
This diagnosis is consistent with the evidence but not yet proven from the Fly
API, so proving it is step one.

## Plan

1. **Prove the cause before changing anything.** Pull the runner machine's
   recent Fly events (exit code, OOM flag, restart timestamps) and the tail of
   the job log, and show them in the panel's failure detail. If the machine
   restarted mid-install, the events list says so.
2. **Never leave a dead job spinning.** When the job's pid is gone and no result
   file exists, mark it failed with a real explanation ("the runner restarted
   during the install — most likely out of memory") instead of an endless
   active step. The step mapper already renders `failed` states; it just needs
   this case fed to it.
3. **Give the install room.** Raise the runner guest to 4 vCPU / 4096 MB and the
   volume to 10 GB, point the npm cache at the volume, and install with
   `--no-audit --no-fund --prefer-offline`. Also cap Node's heap so npm fails
   loudly instead of being killed by the kernel.
4. **Make the install resumable and observable.** Install in a few smaller
   groups with `echo STEP:deps:<n>` markers between them, so a retry after a
   restart reuses what is already on the volume and the timeline advances
   through the long phase instead of sitting on one line. `Prepare runner`
   already skips re-downloading the bundle when it is unchanged; the same guard
   applies to groups that are already present.
5. **Heartbeat in the log.** Write a timestamped line every 30s while a job runs
   so a stalled job is visibly stalled (last heartbeat age) rather than
   indistinguishable from a working one.

## Technical notes

- Files: `src/lib/midnight/fly.server.ts` (runner guest size, volume size, a
  `machineEvents` helper), `src/lib/midnight/runner.server.ts` (job wrapper
  heartbeat, staged dependency install, dead-job detection in `readJob`),
  `src/lib/runner-steps.ts` (per-group deps steps, failed-without-result copy),
  `src/components/deploy/ContractLifecycle.tsx` (surface machine events in the
  failure detail).
- Resizing the guest re-creates the runner machine; the `/work` volume and
  therefore the private state and any deployed contract address survive.
- No database migration, no contract change, no re-compile of the Compact
  contract.

## Verify

1. Open the Midnight page, press **Prepare runner**.
2. The deps phase advances through its sub-steps; a heartbeat keeps the log
   moving.
3. It ends either at **Toolchain ready** or as a red step with the machine's
   exit reason — never as a permanent spinner.
4. **Deploy contract** then runs against the prepared toolchain.
