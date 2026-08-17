# Fix the Fly stack boot failures (Identus + Midnight)

## What the logs show

The PRISM node crash in your screenshots is a DNS failure, not a database or JVM problem:

```text
java.net.UnknownHostException: identus-postgres.process.creative-identus.internal
FlywaySqlException: Unable to obtain connection from database (jdbc:postgresql://identus-postgres.process.creative-identus.internal:5432/node)
```

Every service-to-service hostname in both stacks uses the form
`<machine-name>.process.<app>.internal`. On Fly that name only resolves when the machine
carries the `fly_process_group` metadata key — the machine *name* is not part of private DNS.
Our provisioner sets `name` but never sets that metadata, so none of these resolve:

- Identus: Postgres host for prism-node and for all three agent databases; `PRISM_NODE_HOST`.
- Midnight: `APP__INFRA__NODE__URL` for the indexer (same latent bug — the indexer can never
  see the node, so it never syncs and the timeline sits at "Indexer syncing" forever).

The Midnight node itself is running and producing blocks (screenshots show `Imported #5`), which
confirms the node image and preset are fine.

## Fixes

### 1. Private DNS (root cause)

Attach `metadata: { fly_process_group: "<machine-name>" }` when creating and updating every
machine in both provisioners, so `identus-postgres.process.<app>.internal`,
`identus-prism-node.process.<app>.internal` and `midnight-node.process.<app>.internal` resolve.
Existing machines get the metadata on the next Check/re-provision pass, so a stack you already
created can be repaired without destroying it.

### 2. Midnight node reachability over Fly's IPv6-only private network

Adopted from the flymidnight reference repo, where these are recorded as invariants:

- Node command: `--alice --force-authoring --experimental-rpc-endpoint "listen-addr=[::]:9944,methods=unsafe"`.
  Without `--alice --force-authoring` the node boots as a plain full node; without the IPv6
  listen address the RPC socket is IPv4-only and unreachable from the indexer over 6PN.
- Indexer: add `APP__INFRA__API__ADDRESS = "::"` so its GraphQL API binds IPv6.
- Node's 9944 stays private (no public port) — the indexer is the public surface.

### 3. Image and size corrections (also from the reference repo)

- Pin the proof server to `midnightntwrk/proof-server:8.0.3` instead of `:latest`, and keep it
  at 2 CPU / 2 GB minimum (cold key load needs ~1.5 GB).
- Keep the node on `midnight-node:0.22.5` (2.x tags are Partner Chain builds that crash-loop).

### 4. Surface the real failure in the UI

The deploy timeline currently shows "PRISM node booting" spinning indefinitely for exactly this
class of failure. Add a Fly-side signal: when a machine has restarted repeatedly or reports a
non-zero exit, mark the corresponding step failed and show the machine's last exit/health output
inline, with the existing Retry action plus a "Repair stack config" action that re-applies the
corrected machine specs (metadata, node command, env) to an already-provisioned stack.

## Technical notes

- Files: `src/lib/identus/fly.server.ts`, `src/lib/midnight/fly.server.ts`,
  `src/lib/midnight/shared.ts`, `src/lib/stack.functions.ts` (repair function),
  `src/lib/stack-steps.ts` and `src/components/deploy/StackTimeline.tsx` (failure surfacing),
  `src/routes/app.deploy.tsx` (repair button).
- No database migration and no schema change.
- Repair is idempotent: it updates machine configs in place and restarts them; chain data and the
  Postgres volume are untouched.

## Verify

1. Repair the existing `creative` stack from the Deploy page, then Check.
2. Identus: `identus-cloud-agent` health goes green on all four probes (allow ~5 min for the
   four database migrations).
3. Midnight: indexer step reports a rising block height, proof server answers on 6300.
