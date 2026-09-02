# Debug: both halves show "provisioning · 0 of N steps" while Fly says everything is running

## What is actually wrong

The stacks are fine. Fly shows `test-identus` with 3 machines and `test-midnight` with 4 machines, both green. The **readiness check request is dying**, and the page has no way to say so.

Published worker logs for the minutes those screenshots were taken:

```text
00:47:22  POST /_serverFn/... → 200      <- last successful check
00:47:33  POST /_serverFn/... → 200
00:47:54  POST /_serverFn/... → 0        <- from here on, every check dies
00:49:44  POST /_serverFn/... → 0
00:51:28  POST /_serverFn/... → 0
00:51:33  POST /_serverFn/... → 0
00:52:28  POST /_serverFn/... → 0
```

Status `0` means the request never completed. Those POSTs are the readiness poll firing on its ~12s interval, and each one is `checkFullStack`.

When that call fails, the deploy page has no error path: `readiness.data` stays `undefined`, so `identus`/`midnight` are `undefined`, so every step is derived from nothing and renders pending, and the status text falls back to the **stale database row** — which still says `provisioning` from before. Hence "provisioning · 0 of 8 steps complete · 4m elapsed" over healthy machines, with no error anywhere. The elapsed timer is measured from the stack row's `created_at`, so it keeps counting regardless.

## Why the check dies

`checkFullStack` does one long serial fan-out inside a single request: Identus machine states, Identus app existence, agent health probes, agent log tail, then Midnight machine states, app existence, indexer/proof probes, and Midnight diagnostics. The log tail and diagnostics are the expensive ones — they run commands on the machines through Fly's exec API, which is slow and only bounded by Fly's own 30s cap, and they only run *when something is not ready*, which is exactly the state this stack is in. Stacked on top of the Fly calls, the whole handler exceeds the request budget and the POST is torn down. That also explains the timing: the checks succeeded while things were briefly quick, then began failing once the not-ready diagnostics path became the norm.

## Fix

**1. Never render a blank timeline on a failed check.** Surface the readiness query's error state on the deploy page: keep the last successful payload visible rather than dropping to nothing, show a "couldn't reach the stack check" line with the error and the Retry button, and fall back to the `machines` array already persisted on the `fly_deployments` row so real machine states still show. A failed check must never look like a stack that has completed zero steps.

**2. Split the check into fast and slow halves.** `checkFullStack` returns only the cheap signals — app existence, machine states, and the HTTP health probes — with the Identus and Midnight sides run concurrently instead of one after the other, and a per-call timeout so one hanging Fly request cannot sink the whole response.

**3. Move diagnostics to their own on-demand call.** The agent log tail and Midnight indexer/node diagnostics become a separate server function the page fetches only when the fast check reports a half as not ready, on a slower interval, with its own failure handling. A failed diagnostics fetch degrades to "no log captured", never to a broken timeline.

**4. Bound every exec-based read.** Wrap the log-tail and diagnostics exec calls in an explicit timeout well under the request budget, so they return partial text instead of hanging.

## Technical notes

- `src/lib/stack.functions.ts`: `checkFullStack` drops `agentLogTail`/`midnightDiagnostics`, runs the two halves with `Promise.all`, and wraps each Fly read in a timeout helper; a new `stackDiagnostics` server function carries the slow reads.
- `src/lib/identus/fly.server.ts`, `src/lib/midnight/fly.server.ts`: timeout guards around the `machines/:id/exec` reads.
- `src/routes/app.deploy.tsx`: readiness query keeps previous data, renders an error banner with Retry, falls back to persisted machine states, and adds the separate diagnostics query wired into the existing `logTail`/`diagnostics` step inputs.
- `src/lib/stack-steps.ts`: a `checkFailed` input so the timeline can say "status unknown — the readiness check failed" instead of implying zero progress.
- No migration, no contract change, no Fly teardown. The running machines are untouched.

## Verify

1. Open the Deploy page. The check completes (a `200`, not a `0`) and both halves show their real machine states within a second or two.
2. With both stacks healthy the timelines fill in and reach ready; a half that is genuinely stuck still shows its log/diagnostics, now loaded separately.
3. Force a check failure (bad prefix) and the panel shows an explicit error with Retry — never "0 of 8 steps" on running machines.
