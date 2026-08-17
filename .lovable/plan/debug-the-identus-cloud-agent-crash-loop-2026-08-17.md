# Debug the Identus cloud agent crash loop

## What the screenshots actually show

- The Identus half now fails earlier than last time: **"Cloud agent booting — restarting"**,
  with `identus-cloud-agent exited with code 1 (2 exits recorded)`. So the wallet-seed
  change did not fix the boot; the container still dies and Fly keeps restarting it.
- The Fly log panes in the other screenshots are **prism-node logs** (`io.iohk.atala.prism.node.*`
  Submission Service / AtalaObjectsTransactionsRepository, all `INFO`) — that machine is
  healthy. None of the captured frames contain the cloud-agent's own error line.
- Our in-app log reader (`agentLogTail` in `src/lib/identus/fly.server.ts`) returned nothing:
  the failed step shows only the exit-code detail, no agent error text. I confirmed the
  legacy log endpoint it calls (`api.fly.io/api/v1/apps/{app}/logs`) answers **401** for a
  Machines-style token, so that path can never produce a line.

So the real exception message is still unknown. The plan makes it visible first, then applies
the fix the message names — rather than guessing a third time.

## Plan

1. **Make the agent's own error readable in the console.**
   - Replace the 401-prone legacy log call with a source that works with the Machines token:
     read the machine detail's health-check `output` plus the `exit_event` fields
     (`guest_exit_code`, `oom_killed`, `requested_stop`) which the Machines API does return.
   - Add a reliable stdout capture: run the agent under a tiny shell wrapper so its output is
     tee'd to a file inside the container, then read the tail through the Machines
     `POST /apps/{app}/machines/{id}/exec` endpoint. That gives us the actual Scala exception
     message, not just the frames.
   - Surface the captured text as the `detail` on the failing step in `StackTimeline`, with a
     copy button so long JVM traces can be pulled out on mobile.

2. **Align the agent machine env with the known-good reference config while we are in there.**
   Two differences from the reference stack stand out and are cheap to correct:
   - the agent is missing the `POSTGRES_*` connection group (the reference sets four groups:
     `POLLUX_DB_*`, `CONNECT_DB_*`, `AGENT_DB_*`, `POSTGRES_*`);
   - the Postgres machine declares an empty `services` block; the reference has none and is
     reached over the private network only.

3. **Apply the cause the log names.** Ranked expectations, so the fix is one edit once we can
   read the line: missing/failed schema migration on one of the four databases; a JDBC
   connection refused over IPv6; an invalid `DEFAULT_WALLET_SEED` rejection (in which case the
   seed is removed again rather than re-derived); or an OOM during migration.

4. **Roll out with Repair config on the `creative` stack, then Check** — no destroy, no
   re-provision. Midnight stays untouched; it is green and importing blocks.

## Technical notes

- Files: `src/lib/identus/fly.server.ts` (env, exec-based log tail, exit-event parsing),
  `src/lib/identus/fly-shared.ts` if a wrapper command constant is needed,
  `src/lib/stack.functions.ts` and `src/lib/stack-steps.ts` (carry the log text to the failing
  step), `src/components/deploy/StackTimeline.tsx` (render long detail + copy).
- No database schema change.
- The admin key and derived seed stay server-side and are never rendered.

## Verify

1. Repair config on `creative`, then Check: the failing step now shows the agent's real error
   line, not just an exit code.
2. After the fix from step 3, all four Identus probes (system, DID registrar, issuance,
   connections) go green inside the 300s grace period.
3. Publishing an issuer DID from the Identus page succeeds.
