# Fix the Identus repair deadlock

## What is happening

The repair path updates an existing Fly machine and immediately calls its `restart` endpoint. The update already moves the machine through a transition, so the second call can arrive while the machine is neither fully started nor fully stopped; Fly rejects that race with the observed `412 failed_precondition`. Because the repair loop stops there, the cloud-agent replacement/log-volume step may never run, leaving the UI with the fallback “the machine hasn't started.”

## Changes

1. **Make Identus machine updates transition-safe**
   - Remove the redundant immediate restart after a machine config update.
   - Wait for the updated machine to reach `started` before advancing to dependent machines.
   - Keep Postgres recreation and the cloud-agent recreation needed for the persistent boot-log volume.

2. **Apply the same safe behavior to agent reconnect/config repair**
   - Reuse the transition-safe update flow for the endpoint/key repair path so `Reconnect` cannot hit the same 412 race.
   - Preserve the current machine ordering and do not touch the Midnight half.

3. **Keep diagnostics truthful**
   - Replace the generic legacy “machine hasn't started” fallback with the current machine state and a retryable explanation when logs are temporarily unreadable.
   - Continue exposing the persisted JVM boot log once the repaired cloud-agent is running or in its crash-hold window.

4. **Verify without destroying the stack**
   - Confirm the project builds cleanly.
   - Run the Identus-only repair once, then check that all three Identus machines are present, the 412 error is gone, and either health probes pass or the Boot log shows the actual JVM/database failure.

## Scope

No full-stack destroy or reprovision. Midnight and its ledger data remain untouched.
