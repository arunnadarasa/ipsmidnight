# Capture and fix the Identus cloud-agent crash

## Confirmed diagnosis

- The Fly screenshots contain only healthy PRISM-node `INFO` messages (`SubmissionService` and `AtalaObjectsTransactionsRepository`). They do not show the cloud-agent process that exits with code 1.
- The in-app log path is valid: Fly's Machines API accepts the current `command` array and returns `stdout`, `stderr`, and `exit_code`.
- The capture timing is the immediate problem. The launch wrapper waits only **1 second** after the JVM exits, but the deployment console polls every **12 seconds**. The machine is therefore almost always restarting when the app tries to exec `tail`, so the real exception remains hidden.
- The underlying JVM crash cause is still unconfirmed. No further database or wallet setting should be guessed until its exception message is captured.

## Plan

1. **Make the failed process inspectable.**
   - Keep the cloud-agent machine alive for a short diagnostic window after the JVM exits (about 90 seconds), while retaining the JVM's real exit code for the eventual Fly restart.
   - Add an explicit exit marker to the captured file and stop the background tail cleanly before exiting.
   - Truncate the log file at each boot so old failures cannot be mistaken for the current one.

2. **Stop swallowing diagnostic failures.**
   - Return a typed diagnostic result from the Machines exec call: captured agent text, exec failure, health-check output, and machine exit summary.
   - Remove the legacy Fly log request that is known to return 401 for this token type.
   - Prefer the first `Caused by` / exception block with enough surrounding lines to identify the failing component, rather than a single isolated frame.

3. **Expose the evidence in the deployment timeline.**
   - Show the current cloud-agent exception under “Cloud agent booting,” with the existing copy action.
   - If exec itself fails, show that reason instead of repeating only “exit code 1.”
   - Treat later health steps as pending after a boot failure rather than leaving “Agent health: system” spinning.

4. **Repair only the Identus half and capture one complete failure.**
   - Reapply the cloud-agent config without restarting the healthy Midnight stack or PRISM/Postgres machines.
   - Poll during the 90-second diagnostic window and retrieve the actual exception.

5. **Apply the exact correction named by that exception.**
   - Database migration/connectivity error: correct only the named host/database/credential variable.
   - Wallet/secret-storage validation error: correct or remove only the rejected wallet setting.
   - PRISM gRPC error: correct the node endpoint or transport setting.
   - Memory failure: adjust the cloud-agent machine memory/JVM budget.
   - Then restore a short post-exit delay and verify stable readiness.

## Technical scope

- `src/lib/identus/fly-shared.ts`: resilient diagnostic launch wrapper.
- `src/lib/identus/fly.server.ts`: typed exec diagnostics and exception extraction.
- `src/lib/stack.functions.ts`: carry diagnostic state to the client.
- `src/lib/stack-steps.ts`: fail boot cleanly and keep downstream probes pending.
- `src/routes/app.deploy.tsx` / `StackTimeline.tsx`: display and copy the captured evidence.
- Add an Identus-only repair path; do not touch the healthy Midnight deployment.

## Verification

1. Identus repair starts a new cloud-agent boot without restarting Midnight.
2. Within one console poll, the failing boot step shows the cloud-agent's own exception message.
3. After the exception-specific fix, the machine records no new non-zero exit and all four agent probes pass.
4. Midnight remains ready and continues advancing blocks.
5. Publish an issuer DID to confirm the agent is operational beyond its health endpoint.