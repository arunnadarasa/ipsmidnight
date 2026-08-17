# Fix: destroyed Midnight stack shown as "still deploying"

## What the evidence shows

- Your Fly account has 4 apps and **no `creative-midnight`** app (screenshot 2). Only `creative-identus` (3 machines) exists.
- The database has **one** deployment row: `kind=identus`, `app_prefix=creative`, `status=ready`. There is **no `midnight` row at all**.
- The last stack event in the activity log is `stack.destroyed` for prefix `creative` at 08:17 — after that, nothing was provisioned again.

So the Midnight half genuinely does not exist. The console nevertheless renders a "Midnight Undeployed" card with an indexer URL, a ticking "9m 09s elapsed" timer, and a green "Fly app created creative-midnight" step.

## Why the UI lies

Two independent issues:

1. **The app name is derived, never verified.** The status check computes `stackUrls("<prefix>-midnight")` unconditionally, and the timeline marks the "Fly app created" step `done` whenever an app *name* string exists. A name string always exists, so step 1 is always green — even when the Fly app was deleted.
2. **The status write is an UPDATE, not an upsert.** After a destroy removes the rows, the check's `update(...).eq('kind','midnight')` matches nothing, so no Midnight state is ever persisted again; the card falls back to derived URLs and a `unknown` status while the elapsed timer keeps running from the card mount.

## What to change

1. **Treat "no machines and no app" as not provisioned.** In the readiness check, add an explicit app-existence result for each half (the Fly app GET already distinguishes 404 from other errors) and return `exists: boolean` alongside machines/probes.
2. **Timeline honesty** (`src/lib/stack-steps.ts`): when the app does not exist, the "Fly app created" step is `pending` (not `done`) and the half reports `not provisioned` instead of `unknown`. Later steps stay pending, with no spinner.
3. **Deploy console** (`src/routes/app.deploy.tsx`): for a half that is not provisioned, hide the derived indexer/agent URLs and the elapsed timer, and show a single primary action — **Provision Midnight** (reusing the existing reconnect/provision-missing-half path) — instead of Check/Repair buttons that cannot succeed.
4. **Persist status even with no row**: change the two status writes in `checkFullStack` from `update` to `upsert` on `(user_id, app_prefix, kind)` so a half that reappears (or is re-provisioned) records state again, and so a destroyed half is recorded as `absent` rather than silently skipped.
5. **Destroy path consistency**: after `destroyFullStack`, ensure both rows are removed/marked absent so a stale half cannot resurface as a phantom card.

## Notes

No changes to the Fly machine specs, images, or Midnight/Identus wiring — this is a state-reporting fix. Once merged, your `creative` stack will show Identus **ready** and Midnight **not provisioned**, with one button to bring the Midnight half back up.
