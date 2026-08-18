# Update the Lovable Midnight skill with the latest hard-won lessons

Append one new dated section to the end of the `lovable-midnight` skill draft (`.agents/skills/lovable-midnight/SKILL.md`, currently 892 lines), then re-apply the draft so it becomes active. No app code changes.

## New section: runner toolchain, job observability, anchor UX

**1. Pin the whole Compact/Midnight toolchain, including transitive alphas**
- `@midnight-ntwrk/compact-js@2.5.3` depends on `@midnight-ntwrk/ledger-v9@^0.1.0-alpha.1`, which is not published — every install dies with `npm error code ETARGET / notarget No matching version found`. Pin `compact-js@2.5.1`, which resolves cleanly.
- Rule: a runner bootstrap must install exact pinned versions, and a toolchain bump is a deliberate, tested change — never `@latest`.
- Bootstrap must delete stale `package-lock.json`/`node_modules` from a half-finished install before retrying, otherwise the bad resolution is cached forever.
- Add a "clear toolchain" action so a user can reset the install without destroying the volume.

**2. A stalled install on a runner machine is usually an OOM kill, not a hang**
- Symptom: install step stops mid-way with no error, retries forever, job later exits `status=1`.
- Fix: give the runner real resources (4 vCPU / 4 GB, 10 GB volume), install in small sequential groups with a persistent npm cache, and emit heartbeats (~30 s) so the UI can distinguish "slow" from "dead".
- Surface Fly machine events (OOM flag, exit code) in the UI instead of only the log tail.

**3. Detached jobs need step markers, not raw logs**
- Runner scripts print explicit `STEP_*` / `JOB_FAILED status=<n> during: <phase>` markers; the UI maps them onto a monotonic step timeline (same model as the deploy page) with per-step timers and a progress bar.
- On failure: name the exact command that failed and include the npm debug-log tail.
- Persist the failed job's state and log (auto-expanded) after the run ends — a toast alone loses the only diagnostic.
- Always ship a copy-log button; never pipe long proving logs through `head`/`awk` (SIGPIPE kills the prove).

**4. Submitted ≠ verified — one status mapping, honest labels**
- An anchor that landed on-chain is `anchored`, not `verified`. Ledger membership is only confirmed by an explicit read-only check against the contract's public state; until then label it "not re-checked".
- Derive dot colour and badge from a single shared tone helper so a successful state can never render as a failure.
- Once anchored, demote the write action to secondary ("Re-anchor") and promote the verification action to primary.

**5. Mobile-first rows for long-running blockchain operations**
- Single column on mobile: metadata first, then full-width equal-width action buttons; timelines and log tails span the card's full width rather than being squeezed into a metadata column.
- Truncate bundle/record titles so queue lists do not stretch the layout.

Plus matching rows appended to the skill's failure-mode table (ETARGET on an unpublished transitive alpha; silent runner OOM during bulk install; job "failed" with no retained log; anchored row rendered as an error) and two anti-patterns (unpinned toolchain installs on the runner; treating a submitted tx as verified).

## Technical notes
- Edit target: `.agents/skills/lovable-midnight/SKILL.md` — append only, no rewriting of existing sections.
- Follow the file's existing conventions: `## <date> update — <source> hard-won lessons`, numbered non-negotiables, a `| Symptom | Cause | Fix |` table, anti-patterns list.
- Finish with `skills--apply_draft` on `.agents/skills/lovable-midnight` so the updated skill becomes active.
