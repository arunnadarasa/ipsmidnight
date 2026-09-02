import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  AGENT_INIT_EXEC,
  AGENT_EXIT_MARKER,
  AGENT_LOG_DIR,
  AGENT_LOG_HISTORY,
  AGENT_LOG_PATH,
  AGENT_LOG_VOLUME,
  IDENTUS_IMAGES,
  JAVA_TOOL_OPTIONS,
  postgresInitSql,
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
  if (!t) throw new Error("FLY_API_TOKEN is not configured for this project.");
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


async function flyOptional<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    return await fly<T>(path, init);
  } catch (err) {
    // Fly resources can vanish outside the console — treat 404 as "already gone".
    if (err instanceof Error && /→ 404/.test(err.message)) return null;
    throw err;
  }
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

function machineSpec(kind: MachineKind, appName: string, adminKey: string) {
  // Unique per Fly app: tenants share one Fly organisation/private network, so a
  // shared password would let any reachable machine open another tenant's DB.
  const db = identusDbCreds(appName);


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
        POLLUX_DB_USER: db.user,
        POLLUX_DB_PASSWORD: db.password,
        CONNECT_DB_HOST: pgHost,
        CONNECT_DB_PORT: "5432",
        CONNECT_DB_NAME: "connect",
        CONNECT_DB_USER: db.user,
        CONNECT_DB_PASSWORD: db.password,
        AGENT_DB_HOST: pgHost,
        AGENT_DB_PORT: "5432",
        AGENT_DB_NAME: "agent",
        AGENT_DB_USER: db.user,
        AGENT_DB_PASSWORD: db.password,
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
      // Capture the agent's stdout to a file we can read back over exec.
      init: { exec: [...AGENT_INIT_EXEC] },
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

async function ensureMachine(appName: string, kind: MachineKind, region: string, adminKey: string) {
  const spec = machineSpec(kind, appName, adminKey);
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  const existing = machines.find((m) => m.name === spec.name);
  const body = machineBody(spec as { name: string; config: Record<string, unknown> }, region);
  if (existing) {
    await fly(`/apps/${appName}/machines/${existing.id}`, { method: "POST", body });
    return { ...existing, state: "updating" };
  }
  return fly<FlyMachine>(`/apps/${appName}/machines`, { method: "POST", body });
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

 */
export async function repairIdentusStack(appName: string, adminKey: string, region: string) {
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  const repaired: string[] = [];
  for (const kind of ["postgres", "prism-node", "cloud-agent"] as const) {
    const spec = machineSpec(kind, appName, adminKey);
    const existing = machines.find((m) => m.name === spec.name);
    const body = machineBody(spec as { name: string; config: Record<string, unknown> }, region);
    const recreate = kind === "postgres";
    if (existing && recreate) {
      // 404 means it is already gone — either way we continue to the create below.
      await flyOptional(`/apps/${appName}/machines/${existing.id}?force=true`, { method: "DELETE" });
      const fresh = await fly<FlyMachine>(`/apps/${appName}/machines`, { method: "POST", body });
      // Let Postgres finish initdb before the agent is restarted against it,
      // otherwise the agent burns its first boot on "connection refused".
      await flyOptional(`/apps/${appName}/machines/${fresh.id}/wait?state=started&timeout=60`);
    } else if (existing) {
      await fly(`/apps/${appName}/machines/${existing.id}`, { method: "POST", body });
      await flyOptional(`/apps/${appName}/machines/${existing.id}/restart`, { method: "POST" });
    } else {
      await fly(`/apps/${appName}/machines`, { method: "POST", body });
    }

    repaired.push(spec.name);
  }
  return { appName, repaired };
}


export type IdentusProvisionResult = IdentusStackUrls & {
  created: boolean;
  adminKey: string;
  machines: { name: string; id: string; state: string }[];
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
  for (const kind of ["postgres", "prism-node", "cloud-agent"] as const) {
    const m = await ensureMachine(appName, kind, input.region, adminKey);
    machines.push({ name: m.name ?? kind, id: m.id, state: m.state ?? "created" });
  }

  return { ...identusStackUrls(appName), created, adminKey, machines };
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



/**
 * The agent's own error text. The Machines API exposes no log endpoint, so the
 * primary source is the boot log file written by `AGENT_INIT_EXEC`, read back
 * through `machines/:id/exec`. Falls back to the legacy app log API, then to the
 * machine's health-check output. Every failure degrades to a short explanation
 * instead of null so the UI never shows a silent spinner.
 */
export async function agentLogTail(appName: string): Promise<string | null> {
  if (!flyConfigured()) return null;
  try {
    const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
    const agent = machines.find((m) => m.name === "identus-cloud-agent");
    if (!agent) return null;

    // 1. Boot log file inside the machine (works while the machine is running).
    try {
      const exec = await flyOptional<{ exit_code?: number; stdout?: string; stderr?: string }>(
        `/apps/${appName}/machines/${agent.id}/exec`,
        {
          method: "POST",
          body: JSON.stringify({
            command: ["/bin/sh", "-c", `tail -c 4000 ${AGENT_LOG_PATH} 2>/dev/null`],
            timeout: 20,
          }),
        },
      );
      const text = pickErrorText(`${exec?.stdout ?? ""}\n${exec?.stderr ?? ""}`);
      if (text) return text;
    } catch {
      // exec is unavailable while the machine is stopped/restarting — fall through
    }

    // 2. Legacy app log API (works with org-scoped tokens only).
    try {
      const res = await fetch(`https://api.fly.io/api/v1/apps/${appName}/logs?instance=${agent.id}`, {
        headers: { Authorization: `Bearer ${token()}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: { attributes?: { message?: string } }[] };
        const text = pickErrorText((json.data ?? []).map((d) => d.attributes?.message ?? "").join("\n"));
        if (text) return text;
      }
    } catch {
      // ignore
    }

    // 3. Health-check output, plus the exit summary as a last resort.
    const detail = (await flyOptional<FlyMachine>(`/apps/${appName}/machines/${agent.id}`)) ?? agent;
    const checkOutput = (detail.checks ?? [])
      .map((c) => (c.output ?? "").trim())
      .filter(Boolean)
      .join(" | ");
    if (checkOutput) return checkOutput.slice(0, 400);
    const exit = exitSummary(detail);
    if (exit.detail) return `${exit.detail} No log line captured yet — the boot log appears after the next restart.`;
    return null;
  } catch {
    return null;
  }
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
  const spec = machineSpec("cloud-agent", appName, adminKey);
  await fly(`/apps/${appName}/machines/${agent.id}`, {
    method: "POST",
    body: JSON.stringify({ name: spec.name, region, config: spec.config }),
  });
  await flyOptional(`/apps/${appName}/machines/${agent.id}/restart`, { method: "POST" });
  return identusStackUrls(appName);
}
