# Fly.io mode for Identus

Today the Identus page only has **simulated** agents: DIDs and credential JWTs are derived in the browser, nothing external runs. The Midnight page is the only place with Fly provisioning. This plan gives Identus the same treatment — a real Hyperledger Identus Cloud Agent running on Fly.io, provisioned from the console, with simulated mode kept as the zero-setup default.

## What you get

1. **Mode picker on the Identus page** — "Simulated" (as today) or "Fly.io Cloud Agent".
2. **Fly stack panel** (mirrors the Midnight one): app prefix, region picker, Provision / Check / Destroy, live machine states and health probes.
3. **Provisioned stack** — one Fly app with three machines:
   - `postgres:16-alpine` with four databases (`pollux`, `connect`, `agent`, `node`)
   - `identus/prism-node:2.5.0`
   - `identus/identus-cloud-agent:1.40.0` (4 GB RAM, HTTPS on 443, DIDComm on 8090)
   An admin API key is minted at provision time and stored on the connection row.
4. **Readiness watcher** — polls the agent until system, DID-registrar, issuance and connection endpoints all answer, then flips the agent to "ready".
5. **Real DIDs and credentials when a Fly agent is active** — create/publish a `did:prism` with an `assertionMethod` key, then issue a connectionless JWT credential over a saved IPS summary (digest + `dob` claim, never clinical content). Simulated mode is unchanged, so existing records keep working.
6. **Diagnostics** — per-machine state, health-check output, OOM/exit-code events, and a "Repair DIDComm endpoint" action for agents whose invitation host is wrong.

## Technical notes

- New `src/lib/identus/fly.server.ts` (Fly Machines API, machine configs, IP allocation) and `src/lib/identus/cloud-agent.server.ts` (REST calls: health, DID registrar, publish, credential offers), wrapped by `src/lib/identus/fly.functions.ts` and `identus.functions.ts` with `createServerFn` + `requireSupabaseAuth`. Routes import only `*.functions.ts`.
- Reuses the existing `agent_connections` table (`mode`, `base_url`, `api_key`, `readiness_status`, `metadata`); `fly_deployments` gains a `kind` column (`midnight` | `identus`) so both stacks can coexist per user. Fly URLs are stored without the `/cloud-agent` suffix.
- Machine invariants carried over from the reference project: `JAVA_TOOL_OPTIONS=-Djava.net.preferIPv6Addresses=true -Djava.net.preferIPv4Stack=false -XX:MaxRAMPercentage=70` on prism-node and agent, health-check `grace_period: 300s`, pinned Docker Hub tags (never `:latest`), shared IPv4 + v6 allocated at provision, `DIDCOMM_SERVICE_URL=https://<app>.fly.dev:8090`.
- Readiness polls are capped at 60s per request (Fly rejects longer timeouts) and repeated client-side.
- 404s from Fly on destroy/read are treated as "already gone" and mark the connection orphaned instead of erroring.
- Provision, readiness, issuance and destroy all write `activity_log` rows.
- Requires the existing `FLY_API_TOKEN` secret; no new secrets.

## Out of scope

Local `docker compose` mode, the Sprites SDK sandbox, and Compose Lab from the reference project — say the word if you want those too.
