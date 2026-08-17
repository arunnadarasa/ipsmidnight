# Fix the stuck timeline: the agent is healthy, the records are missing

## What I verified

- **The Identus agent on Fly is up and working.** From the sandbox:
  `GET https://creative-identus.fly.dev/_system/health` → `200 {"version":"1.40.0"}`,
  and `GET /connections?offset=0&limit=1` with an API key → `200 {"contents":[],…}`.
  The Postgres 13 pin fixed the migration crash; the agent logs in your screenshots
  are ordinary DID-state-sync INFO lines, not errors.
- **The console has no record of it.** `agent_connections` is **empty** (0 rows), and
  `fly_deployments` holds exactly **one** row: `kind=identus`, `app_prefix=creative`,
  `status=provisioning`. There is no `midnight` row.
- The health step never turns green because the check only probes the agent when it
  finds an `api_key` on an `agent_connections` row; with no row it returns an empty
  probe list, so all four probes stay "waiting" forever and only the log tail is shown.

## Why the records are missing (both are index problems)

1. **`agent_connections` upsert can never work.** The only unique index is
   *partial* — `UNIQUE (user_id, app_prefix) WHERE app_prefix IS NOT NULL` — and
   Postgres cannot infer a partial index for `ON CONFLICT (user_id, app_prefix)`.
   The `onConflict` string also contains a space (`"user_id, app_prefix"`), which is
   read as a column literally named ` app_prefix`. Either alone makes the write fail,
   and the code ignores the returned error, so provisioning "succeeded" silently.
2. **`fly_deployments` can only hold one row per prefix.** Besides the intended
   `(user_id, app_prefix, kind)` index there is a leftover
   `UNIQUE (user_id, app_prefix)`. The Identus row claimed it first, so the Midnight
   upsert hit a duplicate-key error — which is why the Midnight half has no row and
   reported as failed.

## The fix

1. **Migration**
   - Drop `fly_deployments_user_prefix_key` (the two-column leftover); keep
     `fly_deployments_user_prefix_kind_idx`.
   - Replace the partial `agent_connections_user_prefix_idx` with a plain
     `UNIQUE (user_id, app_prefix)` so `ON CONFLICT` can infer it (multiple NULL
     prefixes for simulated agents are still allowed).
2. **Stop swallowing write errors.** `recordIdentusDeployment` and the
   `fly_deployments` upserts in `provisionFullStack` check the returned `error` and
   throw, so a failed record shows up as a provisioning failure instead of a stuck
   timeline. Fix the `onConflict` strings to have no spaces.
3. **Adopt the stack that is already running** — no destroy, no re-provision.
   A new "Reconnect stack" action mints a fresh admin key, writes it into the
   cloud-agent machine env (`ADMIN_TOKEN`, `DEFAULT_WALLET_AUTH_API_KEY`), restarts
   just that machine, and writes the `agent_connections` + `fly_deployments` rows for
   `creative`. After that the four probes have a key to use and go green.
4. **Provision the missing Midnight half** for the same prefix once the index no
   longer blocks its row; the Deploy page gets a per-half "Provision missing half"
   action instead of an all-or-nothing Provision.
5. **Timeline honesty.** When the check finds no stored key, the health step says
   "no stored agent key — run Reconnect stack" rather than spinning with a hint that
   suggests the agent is still booting.

## Technical notes

- Files: new migration under `supabase/migrations/`,
  `src/lib/identus/fly.server.ts` (record helper, reconnect/key-push),
  `src/lib/stack.functions.ts` (error checks, `reconnectStack`, per-half provision),
  `src/lib/stack-steps.ts` and `src/components/deploy/StackTimeline.tsx` (new state text),
  `src/routes/app.deploy.tsx` (actions).
- Admin keys stay server-side and are never rendered.
- No change to the Identus machine images or the Midnight specs.

## Verify

1. Reconnect stack on `creative` → `agent_connections` has one active `fly` row.
2. Check → system, DID registrar, issuance and connections all green; status `ready`.
3. Provision the Midnight half → its own `fly_deployments` row appears and its
   timeline advances.
4. Publishing an issuer DID from the Identus page succeeds.
