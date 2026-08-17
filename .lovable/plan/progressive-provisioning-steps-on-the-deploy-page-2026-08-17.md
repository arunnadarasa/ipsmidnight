# Progressive provisioning steps on the Deploy page

Today the Deploy page shows a spinner and a flat "provisioning / unknown" status while a stack boots — a five-minute wait with no visible progress. This adds a step-by-step timeline, like the NHS Identus console's readiness watcher.

## What you'll see

A vertical checklist under each stack that fills in as the stack comes up, with a live elapsed timer and the current step highlighted:

```text
Identus Cloud Agent                      02:14 elapsed
  [x] Fly app created                    ips-identus
  [x] Public IP allocated
  [x] Postgres started                   started
  [>] PRISM node booting                 starting
  [ ] Cloud agent booting
  [ ] Databases migrating (~4 min)
  [ ] Agent health: system
  [ ] Agent health: DID registrar
  [ ] Agent health: connections

Midnight Undeployed                      02:14 elapsed
  [x] Fly app created                    ips-midnight
  [x] Node started
  [>] Indexer syncing                    block 0
  [ ] Proof server ready
```

Details:
- Each step shows one of four states: pending (dim), active (spinner), done (check), failed (red with the error detail).
- Steps that take a long time carry an inline hint ("first boot migrates four databases, ~4 min").
- A summary line above the list: "3 of 9 steps complete · London · started 06:41".
- When everything is green the timeline collapses into a single "Stack ready in 4m 52s" row, expandable again.
- If a step fails, the failing step stays expanded with the probe detail and a Retry check / Repair action next to it.
- On mobile the timeline is single-column with wrapped labels; identifiers use the existing truncated-mono treatment.

## How it works

- New `src/components/deploy/StackTimeline.tsx` renders steps from a derived model; a small `src/lib/stack-steps.ts` maps the existing `checkFullStack` payload (machine names + states, Identus health probes, Midnight indexer/proof probes and block height) into ordered step descriptors per half. No new backend calls.
- Step state rules: machine present → created; machine state `started` → done, `starting`/`created` → active, `stopped`/`failed` → failed. Identus probes (`system`, `did-registrar`, `issuance`, `connections`) each become a step; Midnight `indexer` / `proof` probes plus block height become steps.
- Elapsed time comes from the stack's `created_at`; the readiness query already polls every 12s while not ready, so the timeline advances on its own. Polling backs off to 20s after 10 minutes so a stuck stack doesn't hammer the API.
- `src/routes/app.deploy.tsx` renders `StackTimeline` inside each `HalfCard`, replacing the current bare status row, and keeps the existing Check / Destroy / Repair buttons.
- No database or server-function changes; nothing about provisioning behaviour changes, only its presentation.
