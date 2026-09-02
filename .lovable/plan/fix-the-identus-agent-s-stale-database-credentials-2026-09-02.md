# Fix the Identus agent’s stale database credentials

## Confirmed diagnosis

The database-side probe now succeeds: the screenshot shows **“Database credentials: agent login verified”**, while the captured agent boot still shows `password authentication failed for user "pollux-application-user"`.

The code confirms these are currently two different checks:

- `identusDbProbe` authenticates locally inside the Postgres machine with the stored application-role password.
- The cloud-agent machine is updated afterward, but `updateMachineAndWait` only waits for the broad `started` state. If the old cloud-agent process is still in its 10-minute crash-hold, that state can already be true, so the wait can return before a fresh boot has actually consumed the new environment.
- The repair continues even if the post-reset probe is not successful, and the UI can therefore show a successful database probe beside an error from the previous agent boot.

This explains the exact contradictory state shown: Postgres accepts the stored password, but a fresh cloud-agent boot with that same password has not yet been proven.

## Plan

1. **Make the database gate strict and bounded.**
   - Poll until Postgres is ready for a real TCP login rather than treating the machine process’s `started` state as database readiness.
   - Reset the application-role passwords when needed, probe again, and abort the repair with the probe detail unless authentication is positively verified.

2. **Force a genuinely fresh cloud-agent boot after the database passes.**
   - Stop the existing cloud-agent machine, apply the updated spec, start it, and wait for a new machine transition/boot rather than accepting an already-true `started` state.
   - Preserve the boot-log volume, but rotate/mark the log at the start of the new boot so diagnostics cannot present an earlier password failure as the result of the latest repair.

3. **Verify the agent’s active credential configuration without exposing secrets.**
   - Compare a server-side fingerprint of the password in the active Fly machine spec with the stored credential used by the successful Postgres probe.
   - Return only match/mismatch status; never return the password or fingerprint to the browser.
   - Treat a mismatch as a failed repair before health checks begin.

4. **Make the UI status truthful.**
   - Distinguish **database login verified** from **agent restarted with verified credentials**.
   - Do not show the combined state as healthy until the fresh agent boot reaches the system health endpoint; label old boot logs as previous-start evidence where applicable.

5. **Add regression coverage.**
   - Cover bounded Postgres readiness, failed-probe aborts, forced agent restart ordering, active-env mismatch, and stale boot-log handling.

## Technical scope

- `src/lib/identus/fly.server.ts`: strict probe loop, fail-closed repair, deterministic cloud-agent restart, active-config comparison, fresh-boot marker.
- `src/lib/identus/fly-shared.ts`: safe marker/fingerprint helpers if needed.
- `src/lib/identus/fly-shared.test.ts` plus focused repair tests: ordering and failure cases.
- `src/lib/stack.functions.ts` and `src/routes/app.deploy.tsx`: expose and render the two separate verified states.
- No database schema change; Midnight and IPS records remain untouched.

## Verification

1. Run **Fix agent DB** once.
2. Confirm the database TCP probe succeeds and the active cloud-agent config matches the stored credential.
3. Confirm a new boot-log marker appears after the repair action and no new `AGENT_EXIT=1` follows it.
4. Mark recovery complete only when all four Identus probes—system, DID registrar, issuance, and connections—pass. Anything not observed remains reported as not checked.
