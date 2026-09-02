# Get the real reason the Identus agent keeps dying

## Where things actually stand

The readiness check is now working — the timeline reports honest progress (3 of 8): the Fly app exists, Postgres is started, and the PRISM node is started and healthy (its own logs in your second screenshot show it polling its in-memory ledger happily).

The one broken piece is the Cloud Agent: it exits with code 1 and Fly restarts it, twice so far. The panel cannot say why, because the only error text we get is `the machine hasn't started`.

That message is the real blocker to fix first. The agent's stdout is teed to `/tmp/agent-boot.log` *inside* the machine and read back over the Machines `exec` endpoint. Two things defeat that:

- `/tmp` is machine-local and wiped on every restart, so the log from the boot that failed is gone.
- `exec` only works against a running machine. The agent exits within seconds of the failure, so almost every read lands in the restart gap and returns "hasn't started".

So we are blind by construction, not because the agent is silent. Fixing the capture is step one; the actual root cause (very likely another DB role/migration or PRISM-node handshake error, but unconfirmed) gets named once we can read it.

## What to change

1. **Hold the machine open after a crash.** Change the agent boot wrapper so that when the entrypoint exits non-zero it appends an `AGENT_EXIT=<code>` marker and then idles for a bounded window (about 10 minutes) before exiting with the real code. The machine stays `started` and readable for that window, so `exec` gets the log instead of racing a restart. Restart policy and the true exit code are preserved.

2. **Put the boot log on a volume.** Attach a small (1 GB) volume to the agent machine, move the log to `/var/log/identus/agent-boot.log`, and rotate per boot (keep the last three: `agent-boot.log`, `.1`, `.2`). The log then survives restarts and machine replacement, so the panel can show the *failing* boot rather than the current one.

3. **Read the newest log regardless of state.** Update the agent log tail so it prefers the persisted file, falls back to the previous boot's file when the current one is empty, and — when `exec` is unavailable — reports plainly "machine restarting, log unavailable" rather than the misleading "hasn't started".

4. **Surface the whole tail, not one guessed line.** Keep the current "pick the strongest error line" heuristic for the inline step message, but also return the last ~4 KB so the Fly-machines drawer can show the full tail with the existing **Copy log** control. A JVM boot failure needs the surrounding frames to diagnose.

5. **Flag stray machines.** Your Fly dashboard shows one machine in the app `stopped` alongside the two started ones. Add a check that lists machines in the agent's app whose state is `stopped` or `failed`, and name them in the diagnostics panel so a leftover from an earlier repair can't quietly confuse the DNS/process-group picture.

6. **Then diagnose.** With the log persisted, restart the agent, read the tail, and fix whatever it names — expected candidates from past boots are a missing DB role, a Flyway migration failure, or an unresolved PRISM node host. That fix is a follow-up once the evidence exists; I will not guess it now.

## Technical notes

- `AGENT_INIT_EXEC` / `AGENT_LOG_PATH` in `src/lib/identus/fly-shared.ts` carry the wrapper and path.
- The volume goes on the `identus-cloud-agent` spec in `machineSpec()` in `src/lib/identus/fly.server.ts`; because a volume can only be added by replacing the machine, `repairIdentusStack` gains the same destroy-and-recreate treatment for the agent that Postgres already has (no patient data lives there).
- `agentLogTail()` gets the multi-file read plus an explicit reason string instead of `null`.
- `identusDiagnostics()` returns the stray-machine list; `src/routes/app.deploy.tsx` renders it under the machines drawer.
- No Midnight code, database schema, or running Midnight machines are touched.
