# Plan: Update README with new features and learnings

## Goal

The existing `README.md` (294 lines) was last updated before several significant additions: the in-app contract deploy UX, the runner machine, the verify script, the security hardening pass, the SDK pinning fix, and the mobile UX improvements. Bring the README up to date so it documents the project as it is now.

## What changed since the last README update

Confirmed by reading the code (not assumed):

1. **In-app contract deployment** — `src/components/deploy/ContractLifecycle.tsx` renders a progressive step timeline (Prepare runner → Deploy contract → anchor/verify) driven by `src/lib/runner-steps.ts`. No more "done in chat" — the full Compact lifecycle runs from the Deploy page on Fly.
2. **The runner machine** — `src/lib/midnight/runner.server.ts` defines a dedicated `node:22-bookworm-slim` machine inside the Midnight Fly app that installs the SDK onto a volume and executes `deploy`/`anchor`/`verify` jobs via nohup + poll, because proving needs a persistent disk and long connections the serverless runtime lacks.
3. **Read-only ledger verification** — `scripts/verify-midnight.mjs` queries the indexer for the contract's public state and calls the generated `ledger()` view's `commitments.member(commitment)`. "A transaction exists" is explicitly NOT treated as verification.
4. **Security hardening** (latest migration `20260818063051`):
   - Storage bucket `midnight-artifacts` gets owner-scoped RLS (folder = `auth.uid()`).
   - `user_roles` gets explicit `WITH CHECK (false)` deny policies for INSERT/UPDATE/DELETE.
   - SECURITY DEFINER functions (`handle_new_user`, `has_role`, `touch_updated_at`) revoked from PUBLIC/anon/authenticated; only `service_role` can execute `has_role`.
   - New `midnight_contracts` table with per-user RLS.
   - `salt` column added to `midnight_anchors` for recomputable commitments.
5. **SDK pinning** — `compact-js@2.5.1` (not 2.5.3, which declares an unpublished `ledger-v9@^0.1.0-alpha.1` and fails ETARGET). Artifact version bumped to `ips-anchor-registry-3`.
6. **Resilient bootstrap** — sequential dependency group installs, persistent npm cache, 30s heartbeats, npm debug-log tail on failure, `package-lock.json` deletion before each retry.
7. **OOM detection** — `machineEventSummary` reads Fly machine events; a job that died without a result file is reported as a likely OOM restart, not "still running".
8. **Runner toolchain reset** — `resetRunnerToolchain` wipes node_modules/npm-cache/.ready without touching the volume or deployed contract.
9. **Monotonic step clamping** — `useMonotonicSteps` / `clampSteps` keep the timeline from regressing when log markers scroll out of the 3 kB tail.
10. **Mobile UX** — anchor rows stack metadata-first with two equal full-width buttons; dot/badge share one `anchorTone` mapping; timeline and runner log span full width.
11. **Copy log button** — `LogTail` component with clipboard copy.

## Edits to README.md

### Feature walkthrough section
- **Midnight console**: add the per-row anchor submit + "Check ledger" verify actions, and note the on-ledger status reads as "anchored · not re-checked" until verified.
- **Deploy console**: add the **Anchor contract** panel — Prepare runner, Deploy contract, Clear toolchain, and the progressive timeline + copy-log. Document that contract deploy/anchor/verify all run on the dedicated runner machine, not from a terminal.
- **Verify**: clarify that "Check ledger" on the Midnight page runs `verify-midnight.mjs` against the contract's `ledger()` view (membership in the on-chain Set), and the result is surfaced as a toast.

### Architecture diagram + module table
- Add the `runner` machine to the Midnight stack box in the ASCII diagram.
- Add rows for: `src/lib/midnight/runner.server.ts`, `src/lib/runner-steps.ts`, `src/components/deploy/ContractLifecycle.tsx`, `scripts/verify-midnight.mjs`.

### Data model table
- Add `midnight_contracts` row.
- Note the `salt` column on `midnight_anchors`.

### Security posture
- Add: storage bucket owner-scoped RLS, `user_roles` client-write deny policies, SECURITY DEFINER function execution restricted to `service_role`.
- Reinforce: commitment recomputability now requires the persisted `salt`.

### Issues table — add rows
| compact-js 2.5.3 `ETARGET` for `ledger-v9@^0.1.0-alpha.1` | 2.5.3 declares a range that was never published (only 1.0.0-rc.x exists) | Pinned `compact-js@2.5.1` (what midnight-js 4.1.1 already resolves); bumped `artifactVersion` so runners re-bootstrap; bootstrap deletes stale `package-lock.json` before each retry |
| Runner install silently killed mid-way (no error, endless spinner) | Slim runner OOM-killed during a single bulk `npm install` | Raised runner to 4 vCPU / 4 GB; split install into 4 sequential groups with persistent npm cache; 30s heartbeats; `machineEventSummary` detects OOM and names it instead of "still running" |
| Job that died reported as "still running" | A killed job leaves no result file and the wrapper is gone, but `alive` was the only check | `readJob` now treats "no result + not alive + JOB_START in log" as a likely OOM restart and surfaces machine events |

### What we would do differently — add
- **Version-pin transitive SDK deps explicitly.** compact-js and midnight-js version independently; a caret on an alpha can point at nothing. Pin every published version, not just the top-level package.
- **Make long-running jobs observable from the start.** Heartbeats, step markers, and OOM detection were retrofitted after a stalled install looked like a spinner. A detached-job model needs all three on day one.
- **Distinguish "submitted" from "verified" in the data model.** An anchor with a tx hash is not verified; the UI and the table should make that gap explicit, not implicit.

### Known limitations — add
- **Contract deploy/anchor/verify needs a healthy stack.** The runner cannot prove without the indexer and proof server; if the stack is down, the lifecycle buttons are disabled.
- **Runner toolchain is per-volume.** A destroyed runner volume means re-running Prepare runner (a few minutes); the deployed contract address is stored in Postgres, not lost.

No other sections change. The README stays under 350 lines.
