# Unified IPS Stack Provisioning

## Goal

One "Provision IPS stack" action that stands up **both** Fly apps — the Identus Cloud Agent (`<prefix>-identus`) and the Midnight stack (`<prefix>-midnight`) — in a single flow, so a user gets credential-issuance infra and anchoring infra together. The two stacks stay physically separate Fly apps (different images, ports, lifecycles) but are launched, checked, and destroyed as one logical unit.

## Current state (verified)

- `fly_deployments` already has a `kind` column (`'midnight'` default) and unique constraint `(user_id, app_prefix, kind)`. Identus and Midnight rows coexist for the same prefix.
- `provisionFlyStack` (`src/lib/midnight/fly.functions.ts`) calls `provisionStack` → writes a `kind: 'midnight'` row.
- `provisionIdentusAgent` (`src/lib/identus/fly.functions.ts`) calls `provisionIdentusStack` → writes a `kind: 'identus'` row **and** an `agent_connections` row (admin key, base URL, DIDComm URL).
- Existing destroy/check functions are per-kind and scoped by prefix — reusable as-is.
- The Identus and Midnight pages each have their own provisioning panels today.

## What to build

### 1. Unified server functions — `src/lib/stack.functions.ts` (new, client-safe)

Thin wrappers that call the existing per-kind provisioners. Reuse, don't duplicate, the raw logic.

- `provisionFullStack({ appPrefix, region, label? })` — `.middleware([requireSupabaseAuth])`
  - Calls `provisionIdentusStack` then `provisionStack` (both from their `.server.ts` modules) under one prefix.
  - On Identus success: writes the `kind: 'identus'` `fly_deployments` row + `agent_connections` row (same logic as `provisionIdentusAgent` — extract into a small shared helper `recordIdentusDeployment` to avoid drift, or call the existing server function's handler body via the imported raw function).
  - On Midnight success: writes the `kind: 'midnight'` row.
  - Partial-failure policy: if one succeeds and the other fails, record the failure on the failed kind's row (`status: 'error'`, `last_error`) and return a result with both statuses so the UI can offer "retry failed half" — never silently roll back the half that worked.
  - Activity log: one `stack.provisioned` entry summarising both app names + region.
  - Returns `{ identus: {...}, midnight: {...}, appName }`.

- `checkFullStack({ appPrefix })` — runs both `identusMachineStates`/`probeAgent` and Midnight `machineStates`/`probeStack`, updates both rows, returns combined readiness `{ identus, midnight, allReady }`.

- `destroyFullStack({ appPrefix })` — calls `destroyIdentusStack` + `destroyStack`, deletes both `fly_deployments` rows, orphans the `agent_connections` row, single activity entry.

### 2. Shared provisioning helper

To avoid duplicating the Identus record-writing logic between `provisionIdentusAgent` and `provisionFullStack`, extract the "write deployment + agent_connection rows after a successful Identus provision" block into `recordIdentusDeployment(supabase, userId, input, result)` in `src/lib/identus/fly.server.ts`, and have both call sites use it. Keeps the admin-key storage path single-sourced.

### 3. UI — `src/routes/app.deploy.tsx` (new route)

A dedicated "Deploy" page that is the primary provisioning entry point:

- A single form: app prefix + region picker (reuse `FLY_REGIONS`) + optional label.
- "Provision IPS stack" button → calls `provisionFullStack`.
- Combined readiness panel: two cards (Identus / Midnight) each showing machine states + probe status, refreshed by `checkFullStack` (poll or manual "Check" button). Links to the relevant workspace once each half is ready (Identus → publish DID + issue; Midnight → deploy contract).
- "Destroy both" action (with confirm) → `destroyFullStack`.
- If one half is in `error` state, surface a "Retry <half>" button that calls the existing per-kind provisioner for just that half.
- Mobile-first layout: stacked cards, sticky primary action.

### 4. Navigation + dashboard CTA

- Add a **Deploy** nav entry to `AppShell.tsx` (first console item, before IPS) with a cloud/rocket icon.
- On `app.index.tsx` dashboard, add a prominent CTA card: "Provision your IPS stack" → links to `/app/deploy`. If a stack already exists, show combined readiness instead of the CTA.

### 5. Leave per-kind panels in place

The Identus (Fly tab) and Midnight pages keep their individual Provision/Check/Destroy for advanced/single-stack use and as the "retry half" target. The unified flow is additive.

## Non-goals

- No new Fly machines, no new Docker images — this is purely orchestration over existing provisioners.
- No change to the contract deploy script or ZK flow.
- No schema migration needed — `fly_deployments` and `agent_connections` already support both kinds for one prefix.

## Verification

- Provision from `/app/deploy` with a fresh prefix → both `fly_deployments` rows appear (kind identus + midnight) and an `agent_connections` row is created.
- `checkFullStack` updates both rows' `status`.
- Destroy removes both rows and orphans the connection.
- Identus page Fly tab and Midnight page still work standalone.
- Build passes; typecheck via `tsgo`.
