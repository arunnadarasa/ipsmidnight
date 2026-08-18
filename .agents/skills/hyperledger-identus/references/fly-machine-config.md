# Fly machine config reference

## Image constants

```ts
export const AGENT_IMAGE = "docker.io/identus/identus-cloud-agent:1.40.0";
export const PRISM_NODE_IMAGE = "docker.io/identus/prism-node:2.5.0";
export const POSTGRES_IMAGE = "postgres:16-alpine";
```

Pin explicit versions — never `:latest`. GHCR packages are not anonymously pullable on Fly; Docker Hub is the public source.

## Three machines per deployment

Each Fly app runs three machines, identified by `metadata.fly_process_group`. Fly's private DNS resolves `<group>.process.<app>.internal`, so the agent reaches Postgres and the prism-node by group name, not machine name.

### Postgres (`postgresMachineConfig`)
- Image: `postgres:16-alpine`, 1 CPU / 1 GB.
- No `services` block — Postgres is reached over 6PN only, never published.
- Init script at `/docker-entrypoint-initdb.d/00-identus-databases.sh` creates four databases: `pollux`, `connect`, `agent`, `node`. Only runs when the data volume is empty.
- `PGDATA=/var/lib/postgresql/data/pgdata`.

### PRISM node (`prismNodeMachineConfig`)
- Image: `identus/prism-node:2.5.0`, 1 CPU / 1 GB.
- `NODE_LEDGER=in-memory` (dev only — no persisted ledger anchoring).
- Connects to the `node` database on Postgres over 6PN.
- `JAVA_TOOL_OPTIONS` forces IPv6 preference (see below).
- gRPC on port 50053, consumed by the agent over 6PN only.

### Cloud Agent (`agentMachineConfig`)
- Image: `identus/identus-cloud-agent:1.40.0`, default 2 CPU / 4 GB.
- Four separate DB connections (`POLLUX_DB_*`, `CONNECT_DB_*`, `AGENT_DB_*`, `POSTGRES_*`) to avoid schema collisions.
- `API_KEY_ENABLED=true`, `ADMIN_TOKEN` and `DEFAULT_WALLET_AUTH_API_KEY` set to the same admin key.
- HTTP on internal port 8085, exposed via ports 80/443.
- `REST_SERVICE_URL` / `DIDCOMM_SERVICE_URL` point at `https://<app>.fly.dev`.
- Health check: `GET /_system/health` on port 8085, `grace_period: 300s`.

## JVM IPv6 flags (critical)

Fly's private network is IPv6-only. The JVM prefers IPv4 by default, so JDBC/gRPC never reach Postgres or the prism-node without:

```
-Djava.net.preferIPv6Addresses=true -Djava.net.preferIPv4Stack=false -XX:MaxRAMPercentage=70
```

Set on **both** prism-node and cloud-agent. `MaxRAMPercentage=70` keeps the heap inside the machine so first-boot schema migrations don't OOM.

## IP allocation

`allocateSharedIpv4(appName)` runs two GraphQL mutations: `shared_v4` then `v6`. Both are needed — the agent's public URL is `https://<app>.fly.dev`.

## URL normalisation

`agentBaseUrl()` strips a trailing `/cloud-agent` for `mode === "fly"`. The upstream compose stack fronts the agent with an APISIX gateway that adds `/cloud-agent`; a direct Fly deploy serves at the root, so stored Fly URLs must not keep the prefix. Docker local URLs keep it (`http://localhost:8085/cloud-agent`).

## Readiness

`awaitAgentReady` (in `src/lib/identus.functions.ts`) polls `probeAgent` with exponential backoff. The `AgentConnection` row tracks `readiness_status` (`unknown` | `waiting` | `ready` | `timeout`), `readiness_attempts`, `readiness_started_at`, `ready_at`. First boot is slow (four DB migrations); expect 1–3 minutes.

## Private DNS (`fly_process_group`)

Fly's internal DNS resolves `<name>.process.<app>.internal` from the machine's
`config.metadata.fly_process_group`, **not** from the machine name. Create every machine with:

```ts
config: { ...spec.config, metadata: { fly_process_group: spec.name } }
```

Without it the agent cannot resolve Postgres or prism-node and fails with `UnknownHostException`.

## Postgres machine: image pin and roles

- Image: `docker.io/postgres:13-alpine`. Postgres 14+ reserves `FORMAT`, which the agent's
  Flyway migrations use unquoted — 16-alpine fails with a bare syntax error.
- The init script must create the four databases **and** the roles the agent authenticates as:
  `pollux-application-user`, `connect-application-user`, `agent-application-user` (LOGIN +
  password), each granted `USAGE` on `public` and privileges on all tables/sequences in its
  database, plus matching `ALTER DEFAULT PRIVILEGES`.
- The init script only runs on an empty volume. Fixing roles therefore means destroying and
  recreating the Postgres machine (the "Fix agent DB" repair), not editing env and restarting.

## Reading logs from a crash-looping machine

The Machines API log stream needs a live machine. For a machine in a restart loop, run a short
`exec` that reads the JVM log inside the machine, keep a generous tail window (the fatal line is
usually followed by pages of HikariPool shutdown noise), and surface the first `ERROR` /
`Caused by` line in the UI.
