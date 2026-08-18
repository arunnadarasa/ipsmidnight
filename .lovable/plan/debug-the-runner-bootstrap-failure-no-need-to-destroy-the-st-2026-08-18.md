# Debug the runner bootstrap failure — no need to destroy the stack

## Short answer

Don't destroy and relaunch. The Fly stack itself is healthy: the node is
authoring and finalising blocks (#412–#415 in the machine logs), the app shows 4
machines running, and a previously confirmed anchor is still visible in block
#397. The failure is confined to the **Prepare runner** job, which now exits
quickly with `job exited with status 1` instead of hanging — that is the new
fail-fast behaviour doing its job.

## The blocker right now: the log disappears exactly when it matters

`ContractLifecycle` sets `jobId` back to `null` as soon as a result arrives, so
the job query is disabled and `LogTail` receives an empty string. The toast says
"see the log", but there is no log left to see — which is why the failure can't
be diagnosed from the UI. That is the first thing to fix.

## Plan

1. **Keep the finished job visible.** When a job returns a result, retain its
   `id`, `kind`, `log` and `result` in component state instead of dropping them.
   On failure, render the log panel already expanded, with the result's error
   message above it.
2. **Fetch more of the log on a failed job.** The poller tails 3 kB, which on a
   staged install is mostly npm noise. On failure, read a larger tail (and
   stderr) once, so the failing command is actually in the captured text.
3. **Name the failing command.** Wrap each bootstrap phase with a marker of what
   is running (`STEP:` marker plus a human line before each command) and echo
   the failing command name in the wrapper's non-zero branch, so the result
   error reads "npm install group 2 failed" rather than a bare status code.
4. **Then read the log and fix the real cause.** Likely candidates, in order:
   npm running out of disk/heap inside a group, the bundle download URL having
   expired between attempts, or the resized machine coming up before the volume
   mount. The fix depends on what step 2 shows, so the plan stops here rather
   than guessing.
5. **Add a "clear runner state" escape hatch** (removes `/work/node_modules`,
   `/work/npm-cache` and `.ready`, keeps the volume) so a corrupt half-install
   can be reset without destroying the whole Fly app.

## Technical notes

- Files: `src/components/deploy/ContractLifecycle.tsx` (retain last job, auto-open
  log on failure), `src/lib/midnight/runner.server.ts` (larger tail on failure,
  per-command failure naming, reset job), `src/lib/runner-steps.ts` (failed-step
  copy), `src/lib/midnight/runner.functions.ts` (expose the reset action).
- No contract change, no re-compile, no database migration, no Fly app teardown.

## Verify

1. Press **Prepare runner**. If it fails, the panel shows the red step, the
   error, and the log already expanded, naming the command that failed.
2. Apply the fix that log points at, re-run, and the timeline reaches
   **Toolchain ready**.
3. **Deploy contract** then runs against the prepared toolchain.
