import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  AGENT_INIT_EXEC,
  AGENT_BOOT_MARKER,
  AGENT_EXIT_MARKER,
  AGENT_LOG_DIR,
  AGENT_LOG_HISTORY,
  AGENT_LOG_PATH,
  AGENT_LOG_VOLUME,
  IDENTUS_IMAGES,
  JAVA_TOOL_OPTIONS,
  cloudAgentDatabaseEnv,
  cloudAgentCredentialConfigMatches,
  postgresInitSql,
  postgresProbeScript,
  postgresResetScript,
  DB_PROBE_MARKERS,
  POSTGRES_AUTH_ENV,


  identusStackUrls,
  type IdentusStackUrls,
} from "./fly-shared";
import { identusDbCreds } from "./db-creds.server";


const MACHINES_API = "https://api.machines.dev/v1";

type FlyExitEvent = { exit_code?: number | null; oom_killed?: boolean | null };

type FlyMachine = {
  id: string;
  name: string;
  state: string;
  region?: string;
  config?: {
    env?: Record<string, string>;
    services?: { internal_port: number }[];
    mounts?: { volume?: string; path?: string }[];
  };
  checks?: { name: string; status: string; output?: string }[];
  events?: FlyEvent[];
};

type FlyEvent = {
  type: string;
  status: string;
  timestamp: number;
  request?: { exit_event?: FlyExitEvent | null } | null;
};

/** Crash-looping machines flip back to `started`; the exit events are the truth. */
function exitSummary(m: FlyMachine) {
  const exits = (m.events ?? []).filter((e) => e.request?.exit_event);
  const last = exits[0]?.request?.exit_event ?? null;
  const exitCode = typeof last?.exit_code === "number" ? last.exit_code : null;
  const oomKilled = Boolean(last?.oom_killed);
  const restarts = exits.length;
  const detail = oomKilled
    ? `${m.name} was killed for running out of memory (restarted ${restarts}×).`
    : exitCode !== null && exitCode !== 0
      ? `${m.name} exited with code ${exitCode} and is restarting (${restarts} exits recorded).`
      : null;
  return { exitCode, oomKilled, restarts, detail };
}


/** Read-only callers use this to degrade gracefully instead of throwing. */
export function flyConfigured() {
  return Boolean(process.env["FLY_API_TOKEN"]);
}

function token() {
  const t = process.env["FLY_API_TOKEN"];
  if (!t)
    throw new Error(
      "Fly.io hosting isn't configured: the FLY_API_TOKEN secret is missing from the server environment. Add or re-save it in project secrets, then retry this repair.",
    );
  return t;
}

async function fly<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  // Every Machines call gets a deadline: one hanging request (exec against a
  // restarting machine is the usual culprit) otherwise stalls the whole
  // readiness check, and the timeline spins with no error to show.
  const { timeoutMs, ...rest } = init ?? {};
  const res = await fetch(`${MACHINES_API}${path}`, {
    ...rest,
    signal: AbortSignal.timeout(timeoutMs ?? 20_000),
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Fly ${init?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}


async function flyOptional<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T | null> {
  try {
    return await fly<T>(path, init);
  } catch (err) {
    // Fly resources can vanish outside the console — treat 404 as "already gone".
    if (err instanceof Error && /→ 404/.test(err.message)) return null;
    throw err;
  }
}

/**
 * Updating a Machine already initiates its replacement/restart. Calling the
 * restart endpoint immediately afterwards races that transition and Fly rejects
 * it with `failed_precondition`. Only issue an explicit start when the update
 * response says the machine is stably stopped, then wait for convergence.
 */
async function updateMachineAndWait(appName: string, machineId: string, body: string) {
  const updated = await fly<FlyMachine>(`/apps/${appName}/machines/${machineId}`, {
    method: "POST",
    body,
  });
  if (updated.state === "stopped") {
    await fly(`/apps/${appName}/machines/${machineId}/start`, { method: "POST" });
  }
  await flyOptional(`/apps/${appName}/machines/${machineId}/wait?state=started&timeout=60`, {
    timeoutMs: 65_000,
  });
  return updated;
}

async function ensureApp(appName: string, orgSlug: string) {
  const existing = await flyOptional<{ name: string }>(`/apps/${appName}`);
  if (existing) return false;
  await fly(`/apps`, { method: "POST", body: JSON.stringify({ app_name: appName, org_slug: orgSlug }) });
  return true;
}

/** An app stays unreachable until a public IP exists; IPs live on the GraphQL API. */
async function allocateIps(appName: string) {
  const mutation = `mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { address type } } }`;
  for (const type of ["shared_v4", "v6"] as const) {
    const res = await fetch("https://api.fly.io/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: mutation, variables: { input: { appId: appName, type } } }),
    });
    await res.text(); // already-allocated is an error we can ignore
  }
}

function b64(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

export function mintAdminKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

type MachineKind = "postgres" | "prism-node" | "cloud-agent";

/**
 * Reuses the agent's log volume in the region or creates it. Returns null on
 * failure so a missing volume degrades to an ephemeral log rather than blocking
 * provisioning altogether.
 */
async function ensureLogVolume(appName: string, region: string): Promise<string | null> {
  try {
    const volumes =
      (await flyOptional<{ id: string; name: string; region: string }[]>(`/apps/${appName}/volumes`)) ?? [];
    const existing = volumes.find((v) => v.name === AGENT_LOG_VOLUME && v.region === region);
    if (existing) return existing.id;
    const created = await fly<{ id: string }>(`/apps/${appName}/volumes`, {
      method: "POST",
      body: JSON.stringify({ name: AGENT_LOG_VOLUME, region, size_gb: 1 }),
    });
    return created.id ?? null;
  } catch {
    return null;
  }
}

async function machineSpec(kind: MachineKind, appName: string, adminKey: string, logVolumeId?: string | null) {
  // Unique per Fly app and persisted server-side: tenants share one Fly
  // organisation/private network, and a derived password would change whenever
  // the Fly token is rotated while Postgres keeps the old one.
  const db = await identusDbCreds(appName);



  const pgHost = `identus-postgres.process.${appName}.internal`;
  const urls = identusStackUrls(appName);

  if (kind === "postgres") {
    return {
      name: "identus-postgres",
      config: {
        image: IDENTUS_IMAGES.postgres,
        env: {
          POSTGRES_USER: db.user,
          POSTGRES_PASSWORD: db.password,
          POSTGRES_DB: "postgres",
          // Pin host auth to the same scheme the role passwords are stored with.
          ...POSTGRES_AUTH_ENV,
        },

        files: [{ guest_path: "/docker-entrypoint-initdb.d/00-init.sql", raw_value: b64(postgresInitSql(db.appRolePassword)) }],
        guest: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
        // Postgres is reached over 6PN only — declaring a service here is what
        // makes Fly treat the machine as a public web service and can stop the
        // private DNS record from being what the JVM expects.
        restart: { policy: "always" },
      },
    };
  }


  if (kind === "prism-node") {
    return {
      name: "identus-prism-node",
      config: {
        image: IDENTUS_IMAGES.prismNode,
        env: {
          NODE_PSQL_HOST: `${pgHost}:5432`,
          NODE_PSQL_DATABASE: "node",
          NODE_PSQL_USERNAME: `${db.user}`,
          NODE_PSQL_PASSWORD: db.password,
          NODE_LEDGER: "in-memory",
          NODE_REFRESH_AND_SUBMIT_PERIOD: "1s",
          NODE_MOVE_SCHEDULED_TO_PENDING_PERIOD: "1s",
          NODE_WALLET_MAX_TPS: "10",
          JAVA_TOOL_OPTIONS,
        },
        guest: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
        services: [{ ports: [], protocol: "tcp", internal_port: 50053, autostop: false }],
        restart: { policy: "always" },
      },
    };
  }

  return {
    name: "identus-cloud-agent",
    config: {
      image: IDENTUS_IMAGES.cloudAgent,
      env: {
        POLLUX_DB_HOST: pgHost,
        POLLUX_DB_PORT: "5432",
        POLLUX_DB_NAME: "pollux",
        CONNECT_DB_HOST: pgHost,
        CONNECT_DB_PORT: "5432",
        CONNECT_DB_NAME: "connect",
        AGENT_DB_HOST: pgHost,
        AGENT_DB_PORT: "5432",
        AGENT_DB_NAME: "agent",
        ...cloudAgentDatabaseEnv({ superuser: db.password, appRole: db.appRolePassword }),
        PRISM_NODE_HOST: `identus-prism-node.process.${appName}.internal`,
        PRISM_NODE_PORT: "50053",
        SECRET_STORAGE_BACKEND: "postgres",
        DEFAULT_WALLET_ENABLED: "true",

        DEFAULT_WALLET_AUTH_API_KEY: adminKey,
        ADMIN_TOKEN: adminKey,
        API_KEY_ENABLED: "true",
        API_KEY_AUTHENTICATE_AS_DEFAULT_USER: "true",
        REST_SERVICE_URL: urls.agentUrl,
        DIDCOMM_SERVICE_URL: urls.didcommUrl,
        JAVA_TOOL_OPTIONS,
      },
      // Capture the agent's stdout to a file we can read back over exec. The
      // volume keeps that file across the restart that follows a crash — without
      // it the failing boot's log is gone before anything can read it.
      init: { exec: [...AGENT_INIT_EXEC] },
      ...(logVolumeId ? { mounts: [{ volume: logVolumeId, path: AGENT_LOG_DIR }] } : {}),
      guest: { cpu_kind: "performance", cpus: 2, memory_mb: 4096 },

      services: [
        {
          ports: [
            { port: 80, handlers: ["http"], force_https: true },
            { port: 443, handlers: ["tls", "http"] },
          ],
          protocol: "tcp",
          internal_port: 8085,
          autostop: false,
        },
        {
          ports: [
            { port: 8090, handlers: ["http", "tls"] },
          ],
          protocol: "tcp",
          internal_port: 8090,
          autostop: false,
        },
      ],
      checks: {
        health: {
          type: "http",
          port: 8085,
          method: "GET",
          path: "/_system/health",
          interval: "30s",
          timeout: "10s",
          // First boot migrates four databases; a short grace restarts mid-migration.
          grace_period: "300s",
        },
      },
      restart: { policy: "always" },
    },
  };
}

/**
 * Fly private DNS keys off the machine's `fly_process_group` metadata, NOT its
 * name: without this, `identus-postgres.process.<app>.internal` throws
 * UnknownHostException and the PRISM node / agent die during Flyway migration.
 */
function machineBody(spec: { name: string; config: Record<string, unknown> }, region: string) {
  return JSON.stringify({
    name: spec.name,
    region,
    config: { ...spec.config, metadata: { fly_process_group: spec.name } },
  });
}

/** True when the running machine is missing the log volume the spec now wants. */
function needsLogVolume(existing: FlyMachine, logVolumeId: string | null) {
  if (!logVolumeId) return false;
  return !(existing.config?.mounts ?? []).some((m) => m.path === AGENT_LOG_DIR);
}

async function ensureMachine(appName: string, kind: MachineKind, region: string, adminKey: string) {
  const logVolumeId = kind === "cloud-agent" ? await ensureLogVolume(appName, region) : null;
  const spec = await machineSpec(kind, appName, adminKey, logVolumeId);
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  const existing = machines.find((m) => m.name === spec.name);
  const body = machineBody(spec as { name: string; config: Record<string, unknown> }, region);
  if (existing) {
    // A mount can only be attached by replacing the machine. Only agent-internal
    // state lives on the agent machine, so recreating it is safe.
    //
    // Postgres is likewise replaced rather than updated: a machine's root
    // filesystem survives restarts, so its data directory is already
    // initialised and the role-creating init script would never run again —
    // leaving roles with whatever password the first boot used.
    if (kind === "postgres" || needsLogVolume(existing, logVolumeId)) {
      await flyOptional(`/apps/${appName}/machines/${existing.id}?force=true`, { method: "DELETE" });
      return fly<FlyMachine>(`/apps/${appName}/machines`, { method: "POST", body });
    }
    await updateMachineAndWait(appName, existing.id, body);
    return { ...existing, state: "updating" };
  }
  return fly<FlyMachine>(`/apps/${appName}/machines`, { method: "POST", body });
}


/** Runs a shell script inside a named machine of the Identus app. */
async function execInMachine(appName: string, machineName: string, script: string, timeout = 20) {
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  const machine = machines.find((m) => m.name === machineName);
  if (!machine) return { ok: false as const, output: null, state: null };
  if (machine.state !== "started") return { ok: false as const, output: null, state: machine.state };
  const res = await flyOptional<{ exit_code?: number; stdout?: string; stderr?: string }>(
    `/apps/${appName}/machines/${machine.id}/exec`,
    { method: "POST", body: JSON.stringify({ command: ["/bin/sh", "-c", script], timeout }) },
  );
  const output = `${res?.stdout ?? ""}\n${res?.stderr ?? ""}`.trim();
  return { ok: true as const, output, state: machine.state };
}

export type IdentusDbProbe = {
  /** Application roles found in Postgres. */
  roles: string[];
  /**
   * True only when a password-checked login over the machine's private network
   * address succeeded — the same path the cloud agent takes. Never set from a
   * loopback login, which initdb's host rules trust unconditionally.
   */
  authOk: boolean | null;
  /** Whether the active cloud-agent machine carries the proven credential. */
  agentConfigMatches: boolean | null;
  detail: string | null;
  /** Address the probe authenticated against (a 6PN address, not loopback). */
  probeHost: string | null;
  /** Stored password verifier per role, e.g. `pollux-application-user:scram`. */
  verifiers: string[];
  /** Effective host authentication rules, for the diagnostics drawer. */
  hba: string | null;
};

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function activeAgentCredentialMatches(appName: string, appRolePassword: string) {
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  const agent = machines.find((m) => m.name === "identus-cloud-agent");
  if (!agent) return null;
  const detail = (await flyOptional<FlyMachine>(`/apps/${appName}/machines/${agent.id}`)) ?? agent;
  return cloudAgentCredentialConfigMatches(detail.config?.env, appRolePassword);
}

/**
 * Observes the Postgres side of the credential contract instead of assuming it:
 * which `*-application-user` roles exist, how their passwords are stored, and
 * whether the configured password actually authenticates *remotely*.
 * `authOk: null` means the probe could not run (machine not started, exec
 * unavailable) — it must never be reported as success.
 */
export async function identusDbProbe(appName: string): Promise<IdentusDbProbe | null> {
  if (!flyConfigured()) return null;
  const unknown = (detail: string | null): IdentusDbProbe => ({
    roles: [],
    authOk: null,
    agentConfigMatches: null,
    detail,
    probeHost: null,
    verifiers: [],
    hba: null,
  });
  try {
    const creds = await identusDbCreds(appName);
    const run = await execInMachine(appName, "identus-postgres", postgresProbeScript(creds.appRolePassword));
    if (!run.ok || !run.output) {
      return unknown(
        run.state ? `Database machine is ${run.state} — credentials can only be probed while it is running.` : null,
      );
    }
    const lines = run.output.split("\n");
    const marker = (key: string) => {
      const line = lines.find((l) => l.trim().startsWith(key));
      return line ? line.trim().slice(key.length).trim() : "";
    };
    const roles = marker(DB_PROBE_MARKERS.roles)
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r.endsWith("-application-user"));
    const verifiers = marker(DB_PROBE_MARKERS.verifier)
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.includes(":"));
    const hbaRaw = marker(DB_PROBE_MARKERS.hba);
    const hba = hbaRaw ? hbaRaw.slice(0, 1200) : null;
    const probeHost = marker(DB_PROBE_MARKERS.host) || null;
    const auth = marker(DB_PROBE_MARKERS.auth);
    // Fail closed: no private address means no remote login was attempted.
    const authOk = auth === "1" && Boolean(probeHost);
    const failedRoles = Object.entries({
      POLLUX: "pollux-application-user",
      CONNECT: "connect-application-user",
      AGENT: "agent-application-user",
    })
      .filter(([key]) => !lines.some((line) => line.trim() === `AUTH_${key}=1`))
      .map(([, role]) => role);
    const mismatched = verifiers.filter((v) => !v.endsWith(":scram"));
    const agentConfigMatches = await activeAgentCredentialMatches(appName, creds.appRolePassword);
    return {
      roles,
      verifiers,
      hba,
      probeHost,
      authOk,
      agentConfigMatches,
      detail: !authOk
        ? [
            !probeHost ? "Could not determine the database machine's private address, so no remote login was attempted." : null,
            failedRoles.length ? `Remote password login rejected for ${failedRoles.join(", ")}.` : null,
            mismatched.length
              ? `Stored password verifier does not match the required scheme: ${mismatched.join(", ")}.`
              : null,
            !failedRoles.length && !mismatched.length && auth ? auth.slice(0, 200) : null,
          ]
            .filter(Boolean)
            .join(" ") || "No response from the credential probe."
        : agentConfigMatches === false
          ? "The active cloud-agent machine still has stale database credentials."
          : null,
    };
  } catch {
    return null;
  }

}

/**
 * Brings the Postgres roles in line with the stored credentials.
 *
 * The init script only executes against an empty data directory, so on an
 * existing volume the only way to fix a mismatch is `ALTER ROLE` in place.
 * Returns the post-reset probe so the caller can gate the agent on an observed
 * success rather than a hopeful one.
 */
export async function repairIdentusDbCredentials(appName: string): Promise<IdentusDbProbe | null> {
  const creds = await identusDbCreds(appName);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const probe = await identusDbProbe(appName);
    if (probe?.authOk === true) return probe;
    // A started machine can precede Postgres readiness. Retry the idempotent
    // reset as the database comes online instead of losing the only reset call
    // to that startup window.
    await execInMachine(appName, "identus-postgres", postgresResetScript(creds.appRolePassword), 30);
    if (attempt < 11) await delay(5_000);
  }
  return identusDbProbe(appName);
}

/**
 * Re-applies the corrected machine specs (process-group metadata, env, ports) to
 * an already-provisioned app and restarts each machine.
 *
 * The Postgres machine is *destroyed and recreated* rather than restarted: its
 * init script only runs against an empty data directory, and a pinned major
 * version change (PG 16 → 13, because the agent's migrations use `format` as a
 * column name) needs a fresh data directory anyway. Only agent-internal state
 * lives there (no patient summaries or issued credentials), and the Midnight app
 * is never touched by this call.
 *
 * The cloud agent is recreated too when it is still missing the boot-log volume:
 * a mount cannot be added to a live machine, and without it every crash-loop
 * reads back as "the machine hasn't started" instead of the JVM exception.
 *
 * Between Postgres and the agent the database credentials are *observed* — and
 * reset in place when they do not match — so the agent is not restarted into
 * another `password authentication failed` boot.
 */
export async function repairIdentusStack(appName: string, adminKey: string, region: string) {
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  const logVolumeId = await ensureLogVolume(appName, region);
  const repaired: string[] = [];
  let dbProbe: IdentusDbProbe | null = null;
  for (const kind of ["postgres", "prism-node", "cloud-agent"] as const) {
    const spec = await machineSpec(kind, appName, adminKey, kind === "cloud-agent" ? logVolumeId : null);
    const existing = machines.find((m) => m.name === spec.name);
    const body = machineBody(spec as { name: string; config: Record<string, unknown> }, region);
    // The crash wrapper deliberately keeps a failed agent process alive for ten
    // minutes so its log remains readable. Recreating the agent is the only
    // deterministic way to guarantee that this repair starts a new process with
    // the newly verified env instead of observing that old process as "started".
    const recreate = kind === "postgres" || kind === "cloud-agent";
    if (existing && recreate) {
      // 404 means it is already gone — either way we continue to the create below.
      await flyOptional(`/apps/${appName}/machines/${existing.id}?force=true`, { method: "DELETE" });
      const fresh = await fly<FlyMachine>(`/apps/${appName}/machines`, { method: "POST", body });
      // Let Postgres finish initdb before the agent is restarted against it,
      // otherwise the agent burns its first boot on "connection refused".
      if (kind === "postgres") {
        await flyOptional(`/apps/${appName}/machines/${fresh.id}/wait?state=started&timeout=60`);
      }
    } else if (existing) {
      await updateMachineAndWait(appName, existing.id, body);
    } else {
      await fly(`/apps/${appName}/machines`, { method: "POST", body });
    }

    // Gate the agent on credentials that are known to work.
    if (kind === "prism-node") {
      dbProbe = await identusDbProbe(appName);
      if (dbProbe?.authOk !== true) {
        dbProbe = await repairIdentusDbCredentials(appName);
      }
      if (dbProbe?.authOk !== true) {
        throw new Error(`Database credential repair could not be verified: ${dbProbe?.detail ?? "probe unavailable"}`);
      }
    }

    if (kind === "cloud-agent") {
      dbProbe = await identusDbProbe(appName);
      if (dbProbe?.authOk !== true || dbProbe.agentConfigMatches !== true) {
        throw new Error(
          dbProbe?.agentConfigMatches === false
            ? "Cloud-agent restart was blocked because its active database credentials do not match the verified Postgres login."
            : `Cloud-agent restart could not be verified: ${dbProbe?.detail ?? "active configuration unavailable"}`,
        );
      }
    }

    repaired.push(spec.name);
  }
  return { appName, repaired, dbProbe };
}



export type IdentusProvisionResult = IdentusStackUrls & {
  created: boolean;
  adminKey: string;
  machines: { name: string; id: string; state: string }[];
  dbProbe: IdentusDbProbe | null;
};

export async function provisionIdentusStack(input: {
  appPrefix: string;
  region: string;
  orgSlug?: string;
  adminKey?: string;
}): Promise<IdentusProvisionResult> {
  const appName = `${input.appPrefix}-identus`;
  const adminKey = input.adminKey ?? mintAdminKey();
  const created = await ensureApp(appName, input.orgSlug ?? "personal");
  await allocateIps(appName);

  const machines: { name: string; id: string; state: string }[] = [];
  // Postgres first: prism-node and the agent both migrate against it on boot.
  const pg = await ensureMachine(appName, "postgres", input.region, adminKey);
  machines.push({ name: pg.name ?? "identus-postgres", id: pg.id, state: pg.state ?? "created" });
  await flyOptional(`/apps/${appName}/machines/${pg.id}/wait?state=started&timeout=60`);

  // Gate on an observed remote password login before anything boots against the
  // database: an agent started into a credential mismatch spends its whole boot
  // crash-looping on `password authentication failed`.
  const dbProbe = await ensureVerifiedDbCredentials(appName);

  for (const kind of ["prism-node", "cloud-agent"] as const) {
    const m = await ensureMachine(appName, kind, input.region, adminKey);
    machines.push({ name: m.name ?? kind, id: m.id, state: m.state ?? "created" });
  }

  return { ...identusStackUrls(appName), created, adminKey, machines, dbProbe };
}

/**
 * Probes the database credentials and, when the remote login is not verified,
 * resets the roles in place and re-probes. Throws with the observed reason
 * rather than letting a caller proceed on an unverified credential.
 */
async function ensureVerifiedDbCredentials(appName: string): Promise<IdentusDbProbe | null> {
  let probe = await identusDbProbe(appName);
  if (probe?.authOk !== true) probe = await repairIdentusDbCredentials(appName);
  if (probe?.authOk !== true) {
    throw new Error(`Database credentials could not be verified: ${probe?.detail ?? "probe unavailable"}`);
  }
  return probe;
}


/**
 * Whether the Fly app itself exists. `null` means "cannot tell" (no token or an
 * API error); only a definite 404 reports `false`.
 */
export async function identusAppExists(appName: string): Promise<boolean | null> {
  if (!flyConfigured()) return null;
  try {
    const app = await flyOptional<{ name: string }>(`/apps/${appName}`);
    return Boolean(app);
  } catch {
    return null;
  }
}

export async function identusMachineStates(appName: string) {
  // No Fly token: there is nothing to read, and throwing here blanks the page.
  if (!flyConfigured()) return [];
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  return machines.map((m) => ({
    name: m.name,
    id: m.id,
    state: m.state,
    region: m.region ?? null,
    checks: (m.checks ?? []).map((c) => ({ name: c.name, status: c.status, output: (c.output ?? "").slice(0, 300) })),
    ...exitSummary(m),
  }));
}

/**
 * Picks the most diagnostic slice out of a raw log blob.
 *
 * Prefers a line that names the actual cause (a Postgres `ERROR:`, a `Caused by`,
 * a "does not exist" / connection failure) over a generic ZIO wrapper or a bare
 * `at …` stack frame — without this, a cause like
 * `ERROR: role "pollux-application-user" does not exist` gets buried under the
 * frames that follow it.
 */
function pickErrorText(raw: string): string | null {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^at\s/.test(l));
  if (!lines.length) return null;

  const strong = /\bERROR:|caused by|does not exist|already exists|denied|refused|unknownhost|no such|out of memory|fatal/i;
  const weak = /error|exception|failed|timeout/i;

  const findLast = (re: RegExp) => {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line && re.test(line)) return i;
    }
    return -1;
  };

  const idx = (() => {
    const s = findLast(strong);
    return s >= 0 ? s : findLast(weak);
  })();

  const slice = idx >= 0 ? lines.slice(idx, idx + 4) : lines.slice(-4);

  // A Postgres syntax/permission error only tells you *what* broke, not which
  // Flyway migration ran it — carry the last "Migrating schema … to version …"
  // line above it so the timeline names the failing migration file.
  const migrating = /migrating schema|flyway.*version/i;
  let prefix: string | null = null;
  for (let i = Math.min(idx, lines.length - 1); i >= 0; i -= 1) {
    const line = lines[i];
    if (line && migrating.test(line)) {
      prefix = line;
      break;
    }
  }
  const parts = prefix ? [prefix, ...slice] : slice;
  return parts.join(" | ").slice(0, 700);
}



export type AgentBootLog = {
  /** One-line-ish diagnosis for the timeline step. */
  summary: string | null;
  /** The raw tail (current boot plus the two previous ones), for the drawer. */
  raw: string | null;
  /** Where the text came from, or why nothing could be read. */
  source: "boot-log" | "app-log-api" | "health-check" | "exit-event" | "unavailable";
  reason: string | null;
};

/**
 * The agent's own error text. The Machines API exposes no log endpoint, so the
 * primary source is the boot log file written by `AGENT_INIT_EXEC` onto the
 * agent's volume, read back through `machines/:id/exec`. Because the wrapper
 * rotates the file per boot and holds a crashed machine open, the *failing*
 * boot is still readable. Falls back to the legacy app log API, then to the
 * machine's health-check output, then to the exit event — and always explains
 * itself rather than returning a bare null the UI cannot narrate.
 */
export async function agentBootLog(appName: string): Promise<AgentBootLog> {
  const none = (source: AgentBootLog["source"], reason: string | null): AgentBootLog => ({
    summary: reason,
    raw: null,
    source,
    reason,
  });
  if (!flyConfigured()) return none("unavailable", null);
  try {
    const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
    const agent = machines.find((m) => m.name === "identus-cloud-agent");
    if (!agent) return none("unavailable", null);

    // 1. Boot logs on the volume: current boot first, then the two before it.
    let execFailed = false;
    try {
      const files = [AGENT_LOG_PATH, ...AGENT_LOG_HISTORY];
      const script = files
        .map((f) => `if [ -s ${f} ]; then echo "===== ${f}"; tail -c 3000 ${f}; echo; fi`)
        .join("; ");
      const exec = await flyOptional<{ exit_code?: number; stdout?: string; stderr?: string }>(
        `/apps/${appName}/machines/${agent.id}/exec`,
        {
          method: "POST",
          body: JSON.stringify({ command: ["/bin/sh", "-c", script], timeout: 20 }),
        },
      );
      const raw = `${exec?.stdout ?? ""}\n${exec?.stderr ?? ""}`.trim();
      if (raw) {
        // Diagnose against the failing boot: the section carrying the exit marker
        // if there is one, otherwise the whole tail.
        const sections = raw.split(/^===== /m).filter((s) => s.trim());
        // The first section is the current boot. Previous files are retained for
        // context in the drawer, but must never become the timeline diagnosis for
        // a newer repair attempt.
        const current = sections[0] ?? raw;
        const currentHasFailure =
          (current.includes(AGENT_EXIT_MARKER) && !/AGENT_EXIT=0\b/.test(current)) ||
          /\bERROR:|caused by|does not exist|denied|refused|unknownhost|out of memory|fatal|exception|failed/i.test(current);
        const summary = currentHasFailure ? pickErrorText(current) : null;
        if (summary) {
          return { summary, raw: raw.slice(-9000), source: "boot-log", reason: null };
        }
        if (current.includes(AGENT_BOOT_MARKER)) {
          return {
            summary: null,
            raw: raw.slice(-9000),
            source: "boot-log",
            reason: "The current agent boot has not reported an error.",
          };
        }
      }
    } catch {
      // exec is unavailable while the machine is stopped/restarting.
      execFailed = true;
    }

    // 2. Legacy app log API (works with org-scoped tokens only).
    try {
      const res = await fetch(`https://api.fly.io/api/v1/apps/${appName}/logs?instance=${agent.id}`, {
        headers: { Authorization: `Bearer ${token()}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: { attributes?: { message?: string } }[] };
        const raw = (json.data ?? []).map((d) => d.attributes?.message ?? "").join("\n").trim();
        // This is a Fly control-plane response, not an agent boot log. Showing
        // it as the diagnosis hides the useful machine-state fallback below.
        if (/^(?:the )?machine (?:hasn't|has not) started[.!]?$/i.test(raw)) {
          throw new Error("Agent log endpoint is temporarily unavailable");
        }
        const summary = pickErrorText(raw);
        if (summary) return { summary, raw: raw.slice(-9000), source: "app-log-api", reason: null };
      }
    } catch {
      // ignore
    }

    // 3. Health-check output, then the exit event.
    const detail = (await flyOptional<FlyMachine>(`/apps/${appName}/machines/${agent.id}`)) ?? agent;
    const checkOutput = (detail.checks ?? [])
      .map((c) => (c.output ?? "").trim())
      .filter(Boolean)
      .join(" | ");
    if (checkOutput) {
      return { summary: checkOutput.slice(0, 400), raw: checkOutput.slice(0, 4000), source: "health-check", reason: null };
    }
    const exit = exitSummary(detail);
    const restarting = execFailed || detail.state !== "started";
    const reason = restarting
      ? `The agent machine is ${detail.state} — its boot log can only be read while it is running. Retry the check in a few seconds.`
      : "No error line in the boot log yet.";
    if (exit.detail) return { summary: `${exit.detail} ${reason}`, raw: null, source: "exit-event", reason };
    return none(restarting ? "unavailable" : "boot-log", restarting ? reason : null);
  } catch {
    return none("unavailable", null);
  }
}

/** Back-compat single-string view used by the readiness timeline. */
export async function agentLogTail(appName: string): Promise<string | null> {
  return (await agentBootLog(appName)).summary;
}



export async function identusDiagnostics(appName: string) {
  if (!flyConfigured()) return { machines: [] as never[], agentLog: null, dbProbe: null } as never;
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  const rows = [] as {
    name: string;
    id: string;
    state: string;
    checks: { name: string; status: string; output: string }[];
    events: { type: string; status: string; detail: string }[];
    didcommUrl: string | null;
    didcommPortPublished: boolean;
  }[];
  for (const m of machines) {
    const detail = await flyOptional<FlyMachine & { events?: FlyEvent[] }>(
      `/apps/${appName}/machines/${m.id}`,
    );
    const events = (detail?.events ?? []).slice(0, 6).map((e) => ({
      type: e.type,
      status: e.status,
      detail: JSON.stringify(e.request ?? {}).slice(0, 200),
    }));
    rows.push({
      name: m.name,
      id: m.id,
      state: m.state,
      checks: (detail?.checks ?? []).map((c) => ({
        name: c.name,
        status: c.status,
        output: (c.output ?? "").slice(0, 400),
      })),
      events,
      didcommUrl: detail?.config?.env?.["DIDCOMM_SERVICE_URL"] ?? null,
      didcommPortPublished: Boolean(detail?.config?.services?.some((s) => s.internal_port === 8090)),
    });
  }
  return rows;
}

export async function destroyIdentusStack(appName: string) {
  await flyOptional(`/apps/${appName}?force=true`, { method: "DELETE" });
  return { destroyed: true };
}

/**
 * Persists the Identus provision result: writes the `fly_deployments` row
 * (kind=identus) and the active `agent_connections` row carrying the admin key.
 * Shared by `provisionIdentusAgent` and the unified `provisionFullStack` so the
 * admin-key storage path stays single-sourced. The supabase client is passed
 * in already scoped to the caller (RLS as the user).
 */
export async function recordIdentusDeployment(
  supabase: SupabaseClient<Database>,
  userId: string,
  input: { appPrefix: string; region: string; label?: string },
  result: IdentusProvisionResult,
) {
  const deployment = await supabase.from("fly_deployments").upsert(
    {
      user_id: userId,
      kind: "identus",
      app_prefix: input.appPrefix,
      region: input.region,
      status: "provisioning",
      last_error: null,
      agent_url: result.agentUrl,
      didcomm_url: result.didcommUrl,
      machines: result.machines as never,
    },
    { onConflict: "user_id,app_prefix,kind" },
  );
  // A silently dropped write leaves the console with no admin key, which shows up
  // later as health probes that spin forever — so fail loudly here instead.
  if (deployment.error) throw new Error(`Could not save the Identus deployment record: ${deployment.error.message}`);

  await supabase.from("agent_connections").update({ is_active: false }).eq("user_id", userId);
  const connection = await supabase.from("agent_connections").upsert(
    {
      user_id: userId,
      label: input.label?.trim() || `Fly agent ${result.appName}`,
      mode: "fly",
      base_url: result.agentUrl,
      didcomm_url: result.didcommUrl,
      api_key: result.adminKey,
      app_prefix: input.appPrefix,
      readiness_status: "provisioning",
      is_active: true,
      last_error: null,
      metadata: { appName: result.appName } as never,
    },
    { onConflict: "user_id,app_prefix" },
  );
  if (connection.error) throw new Error(`Could not save the agent connection: ${connection.error.message}`);
}

/**
 * Adopts an already-running agent whose admin key was never stored: mints a new
 * key, pushes it into the cloud-agent machine env and restarts only that machine.
 * The agent's own data is untouched, so previously published DIDs survive.
 */
export async function reconnectIdentusAgent(input: {
  appPrefix: string;
  region: string;
}): Promise<IdentusProvisionResult> {
  const appName = `${input.appPrefix}-identus`;
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  const agent = machines.find((m) => m.name === "identus-cloud-agent");
  if (!agent) throw new Error(`No cloud agent found on ${appName} — provision the stack first.`);
  const adminKey = mintAdminKey();
  await repairAgentEndpoints(appName, adminKey, input.region);
  const after = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? machines;
  return {
    ...identusStackUrls(appName),
    created: false,
    adminKey,
    machines: after.map((m) => ({ name: m.name, id: m.id, state: m.state })),
  };
}


/** Rewrites DIDCOMM_SERVICE_URL and republishes port 8090 without a full redeploy. */
export async function repairAgentEndpoints(appName: string, adminKey: string, region: string) {
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  const agent = machines.find((m) => m.name === "identus-cloud-agent");
  if (!agent) throw new Error("No cloud-agent machine on this app — provision it first.");
  await ensureMachine(appName, "cloud-agent", region, adminKey);
  return identusStackUrls(appName);
}
