import { IMAGES, INDEXER_ENV, nodeRpcWsUrl, RUNNER, stackUrls, type StackUrls } from "./shared";

const MACHINES_API = "https://api.machines.dev/v1";

const NODE_VOLUME = "midnight_chain";
const NODE_DATA_PATH = "/node/chain";

export type MachineKind = "node" | "indexer" | "proof" | "runner";

type FlyExitEvent = { exit_code?: number | null; oom_killed?: boolean | null };
type FlyMachineEvent = {
  type?: string;
  status?: string;
  timestamp?: number;
  request?: { exit_event?: FlyExitEvent | null } | null;
};
type FlyMachine = {
  id: string;
  name: string;
  state: string;
  region?: string;
  events?: FlyMachineEvent[];
  config?: { image?: string } | null;
};


/** Read-only callers use this to degrade gracefully instead of throwing. */
export function flyConfigured() {
  return Boolean(process.env["FLY_API_TOKEN"]);
}

function token() {
  const t = process.env["FLY_API_TOKEN"];
  if (!t) throw new Error("FLY_API_TOKEN is not configured for this project.");
  return t;
}

async function fly<T>(path: string, init?: RequestInit & { raw?: boolean; timeoutMs?: number }): Promise<T> {
  // Deadline on every Machines call — a hanging request would otherwise freeze
  // the readiness check and leave the deploy timeline spinning forever.
  const { timeoutMs, raw: _raw, ...rest } = init ?? {};
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
    if (err instanceof Error && /→ 404/.test(err.message)) return null;
    throw err;
  }
}

async function ensureApp(appName: string, orgSlug: string) {
  const existing = await flyOptional<{ name: string }>(`/apps/${appName}`);
  if (existing) return false;
  await fly(`/apps`, {
    method: "POST",
    body: JSON.stringify({ app_name: appName, org_slug: orgSlug }),
  });
  return true;
}

/**
 * Public IPs are allocated through the GraphQL API, not the Machines API.
 * The `private` allocation is what makes `<app>.flycast` resolve — without it
 * the indexer cannot reach the node's RPC through the Fly proxy.
 */
async function allocateIps(appName: string) {
  const mutation = `mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { address type } } }`;
  for (const type of ["shared_v4", "v6", "private"] as const) {
    const res = await fetch("https://api.fly.io/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: mutation, variables: { input: { appId: appName, type } } }),
    });
    // Already-allocated IPs return an error we can safely ignore.
    await res.text();
  }
}

/**
 * Reads the allocated IPs back. The allocate mutation swallows its own errors,
 * so "flycast should work" was an assumption — this turns it into a fact the
 * timeline can state (`flycast: present` / `absent`).
 */
export async function appIpSummary(appName: string): Promise<string> {
  try {
    const res = await fetch("https://api.fly.io/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($name: String!) { app(name: $name) { ipAddresses { nodes { address type } } } }`,
        variables: { name: appName },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return `ip api ${res.status}`;
    const json = (await res.json()) as {
      data?: { app?: { ipAddresses?: { nodes?: { address: string; type: string }[] } } };
    };
    const nodes = json.data?.app?.ipAddresses?.nodes ?? [];
    const types = nodes.map((n) => String(n.type).toLowerCase());
    const flycast = types.some((t) => t.includes("private")) ? "present" : "absent";
    const publicIp = types.some((t) => t.includes("v4") || t === "v6") ? "present" : "absent";
    return `flycast: ${flycast} · public IP: ${publicIp}`;
  } catch (err) {
    return err instanceof Error ? err.message.slice(0, 160) : "ip lookup failed";
  }
}


function machineConfig(
  kind: MachineKind,
  appName: string,
  volumeId?: string | null,
) {
  if (kind === "runner") {
    return {
      name: RUNNER.machine,
      region: undefined,
      config: {
        image: IMAGES.runner,
        // Idles until a job is exec'd into it. No published services: the
        // runner only ever dials out to the indexer and the proof server.
        init: { cmd: ["sleep", "infinity"] },
        guest: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
        // The volume carries node_modules, the compiled contract and the
        // LevelDB private state, so a restart never re-bootstraps or loses the
        // private state a deployed contract was created with.
        ...(volumeId ? { mounts: [{ volume: volumeId, path: RUNNER.work }] } : {}),
        restart: { policy: "always" },
      },
    };
  }

  if (kind === "node") {
    return {
      name: "midnight-node",
      region: undefined,
      config: {
        image: IMAGES.node,
        // Exactly the upstream standalone stack: the `dev` preset already
        // authors blocks. Extra CLI arguments (--alice, --force-authoring,
        // --experimental-rpc-endpoint) made the node dump its whole config and
        // exit 1 in a reboot loop, so the machine runs with no init.cmd at all.
        env: {
          CFG_PRESET: "dev",
          RUST_LOG: "info",
          SIDECHAIN_BLOCK_BENEFICIARY:
            "04bcf7ad3be7a5c790460be82a713af570f22e0f801f6659ab8e84a52be6969e",
        },
        guest: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
        // Chain data survives restarts and repairs, so a deployed contract
        // address stays valid.
        ...(volumeId ? { mounts: [{ volume: volumeId, path: NODE_DATA_PATH }] } : {}),
        // The RPC is published through the Fly edge on 9944 as a plain TLS
        // tunnel (no `http` handler): Fly's HTTP layer closed long-lived
        // WebSocket subscriptions with a 1000 Normal Closure mid-transaction,
        // which broke extrinsic submission. A tls-only handler passes the
        // WebSocket straight through to the IPv4-bound Substrate RPC.
        services: [
          {
            ports: [{ port: 9944, handlers: ["tls"] }],
            protocol: "tcp",
            internal_port: 9944,
            autostop: false,
          },
        ],

        restart: { policy: "always" },
      },
    };
  }

  if (kind === "indexer") {
    return {
      name: "midnight-indexer",
      region: undefined,
      config: {
        image: IMAGES.indexer,
        env: {
          ...INDEXER_ENV,
          APP__INFRA__NODE__URL: nodeRpcWsUrl(appName),
          // Indexer 4.3.x reads the SPO node separately; upstream points both
          // at the same node and omitting it stops the chain indexer booting.
          APP__INFRA__SPO_NODE__URL: nodeRpcWsUrl(appName),
        },

        guest: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
        services: [
          {
            ports: [
              { port: 80, handlers: ["http"], force_https: true },
              { port: 443, handlers: ["tls", "http"] },
            ],
            protocol: "tcp",
            internal_port: 8088,
            autostop: false,
          },
        ],
        restart: { policy: "always" },
      },
    };
  }
  return {
    name: "midnight-proof",
    region: undefined,
    config: {
      image: IMAGES.proof,
      init: { cmd: ["midnight-proof-server", "-v"] },
      // Cold-loading the proving key needs ~1.5 GB; never shrink below 2 GB.
      guest: { cpu_kind: "performance", cpus: 2, memory_mb: 4096 },
      services: [
        {
          ports: [{ port: 6300, handlers: ["tls", "http"] }],
          protocol: "tcp",
          internal_port: 6300,
          autostop: false,
        },
      ],
      restart: { policy: "always" },
    },
  };
}

/**
 * Fly private DNS resolves `<group>.process.<app>.internal` from the machine's
 * `fly_process_group` metadata, not its name — without it the indexer can never
 * reach ws://midnight-node.process.<app>.internal:9944.
 */
function machineBody(spec: { name: string; config: Record<string, unknown> }, region: string) {
  return JSON.stringify({
    name: spec.name,
    region,
    config: { ...spec.config, metadata: { fly_process_group: spec.name } },
  });
}

/**
 * Reuses an existing volume in the region or creates one. Returns null on
 * failure so a missing volume degrades to ephemeral data rather than blocking
 * the whole provision.
 */
async function ensureVolume(
  appName: string,
  region: string,
  name: string,
  sizeGb: number,
): Promise<string | null> {
  try {
    const volumes =
      (await flyOptional<{ id: string; name: string; region: string }[]>(`/apps/${appName}/volumes`)) ?? [];
    const existing = volumes.find((v) => v.name === name && v.region === region);
    if (existing) return existing.id;
    const created = await fly<{ id: string }>(`/apps/${appName}/volumes`, {
      method: "POST",
      body: JSON.stringify({ name, region, size_gb: sizeGb }),
    });
    return created.id;
  } catch {
    return null;
  }
}

/** Chain data for the node, SDK + private state for the runner. */
function volumeFor(appName: string, region: string, kind: MachineKind) {
  if (kind === "node") return ensureVolume(appName, region, NODE_VOLUME, 10);
  if (kind === "runner") return ensureVolume(appName, region, RUNNER.volume, 5);
  return Promise.resolve(null);
}

async function ensureMachine(
  appName: string,
  kind: MachineKind,
  region: string,
): Promise<FlyMachine> {
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  const volumeId = await volumeFor(appName, region, kind);
  const spec = machineConfig(kind, appName, volumeId);
  const existing = machines.find((m) => m.name === spec.name);
  const body = machineBody(spec as { name: string; config: Record<string, unknown> }, region);
  if (existing) {
    await fly(`/apps/${appName}/machines/${existing.id}`, { method: "POST", body });
    return { ...existing, state: "updating" };
  }
  return fly<FlyMachine>(`/apps/${appName}/machines`, { method: "POST", body });
}

/** Re-applies corrected specs to an existing app and restarts each machine. */
export async function repairMidnightStack(appName: string, region: string) {
  // Keeps older apps in step: public IPs for the edge-published node RPC, and a
  // private IP so the flycast diagnostic can still be reported truthfully.
  await allocateIps(appName);
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  const repaired: string[] = [];

  // Node and proof first, indexer LAST: the indexer only retries its node
  // connection on boot, so it must start against an already-listening RPC.
  // The runner is last — it only ever dials the others.
  for (const kind of ["node", "proof", "indexer", "runner"] as const) {
    const volumeId = await volumeFor(appName, region, kind);
    const spec = machineConfig(kind, appName, volumeId);
    const body = machineBody(spec as { name: string; config: Record<string, unknown> }, region);
    const existing = machines.find((m) => m.name === spec.name);
    if (existing) {
      await fly(`/apps/${appName}/machines/${existing.id}`, { method: "POST", body });
      await flyOptional(`/apps/${appName}/machines/${existing.id}/restart`, { method: "POST" });
      if (kind === "node") {
        // Give the RPC a moment to listen again before the indexer is restarted.
        await flyOptional(`/apps/${appName}/machines/${existing.id}/wait?state=started&timeout=60`);
      }
    } else {
      await fly(`/apps/${appName}/machines`, { method: "POST", body });
    }
    repaired.push(spec.name);
  }
  return { appName, repaired };
}


export type ProvisionResult = StackUrls & {
  created: boolean;
  machines: { name: string; id: string; state: string }[];
};

export async function provisionStack(input: {
  appPrefix: string;
  region: string;
  orgSlug?: string;
}): Promise<ProvisionResult> {
  const appName = `${input.appPrefix}-midnight`;
  const created = await ensureApp(appName, input.orgSlug ?? "personal");
  await allocateIps(appName);

  const machines: { name: string; id: string; state: string }[] = [];
  for (const kind of ["node", "indexer", "proof", "runner"] as const) {
    const m = await ensureMachine(appName, kind, input.region);
    machines.push({ name: m.name ?? kind, id: m.id, state: m.state ?? "created" });
  }

  return { ...stackUrls(appName), created, machines };
}

/**
 * A crash-looping machine reports `started` between reboots, so the raw state
 * hides the failure. Fly's event list carries the last exit, which is the only
 * reliable signal that a container is rebooting instead of running.
 */
export function exitSummary(m: FlyMachine): { exitCode: number | null; oomKilled: boolean; restarts: number; detail: string | null } {
  const events = m.events ?? [];
  const exits = events.filter((e) => e.request?.exit_event);
  const last = exits[0]?.request?.exit_event ?? null;
  const exitCode = typeof last?.exit_code === "number" ? last.exit_code : null;
  const oomKilled = Boolean(last?.oom_killed);
  const restarts = exits.length;
  const detail =
    oomKilled
      ? `${m.name} was killed for running out of memory (restarted ${restarts}×).`
      : exitCode !== null && exitCode !== 0
        ? `${m.name} exited with code ${exitCode} and is restarting (${restarts} exits recorded).`
        : null;
  return { exitCode, oomKilled, restarts, detail };
}

/**
 * Whether the Fly app itself exists. `null` means "cannot tell" (no token, or the
 * API errored) — only a definite 404 reports `false`, so the UI never claims a
 * stack is missing on the back of a transient failure.
 */
export async function appExists(appName: string): Promise<boolean | null> {
  if (!flyConfigured()) return null;
  try {
    const app = await flyOptional<{ name: string }>(`/apps/${appName}`);
    return Boolean(app);
  } catch {
    return null;
  }
}

export async function machineStates(appName: string) {
  if (!flyConfigured()) return [];
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  return machines.map((m) => ({
    name: m.name,
    id: m.id,
    state: m.state,
    region: m.region ?? null,
    image: m.config?.image ?? null,
    ...exitSummary(m),
  }));
}


export async function destroyStack(appName: string) {
  await flyOptional(`/apps/${appName}?force=true`, { method: "DELETE" });
  return { destroyed: true };
}

/** Probe order matters: a stalled node makes every other probe misleading. */
export async function probeStack(urls: {
  indexerUrl: string;
  proofUrl: string;
}): Promise<{ indexer: ProbeResult; proof: ProbeResult; blockHeight: number | null }> {
  const indexer = await probeIndexer(urls.indexerUrl);
  const proof = await probeHttp(`${urls.proofUrl}/health`);
  return { indexer: indexer.probe, proof, blockHeight: indexer.blockHeight };
}

export type ProbeResult = { ok: boolean; status: number | null; detail: string };

async function probeHttp(url: string): Promise<ProbeResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const body = (await res.text()).slice(0, 160);
    return { ok: res.ok, status: res.status, detail: body || res.statusText };
  } catch (err) {
    return { ok: false, status: null, detail: err instanceof Error ? err.message : "unreachable" };
  }
}

async function probeIndexer(url: string): Promise<{ probe: ProbeResult; blockHeight: number | null }> {
  try {
    // GraphQL over GET returns 405 — POST is mandatory.
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { block { height hash } }" }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as { data?: { block?: { height?: number } }; errors?: unknown };
    const height = json.data?.block?.height ?? null;
    // An indexer that answers GraphQL but has ingested no block is NOT ready:
    // reporting it as ok made the whole stack look healthy while nothing could
    // be deployed or anchored against an empty chain.
    return {
      probe: {
        ok: res.ok && !json.errors && height !== null,
        status: res.status,
        detail:
          height === null
            ? "GraphQL up, no blocks ingested — the indexer cannot reach the node's RPC"
            : `block #${height}`,
      },
      blockHeight: height,
    };

  } catch (err) {
    return {
      probe: { ok: false, status: null, detail: err instanceof Error ? err.message : "unreachable" },
      blockHeight: null,
    };
  }
}

/** Read-only ledger verification: confirm a contract call really landed. */
export async function verifyAnchorOnChain(input: {
  indexerUrl: string;
  contractAddress: string;
  txHash?: string | null;
}) {
  const query = `query($a: HexEncoded!) {
    contractAction(address: $a) {
      __typename
      address
      transaction { hash block { height } }
    }
  }`;
  try {
    const res = await fetch(input.indexerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { a: input.contractAddress } }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as {
      data?: { contractAction?: { transaction?: { hash?: string; block?: { height?: number } } } };
      errors?: { message: string }[];
    };
    if (json.errors?.length) {
      return { ok: false, detail: json.errors[0]!.message, blockHeight: null, txHash: null };
    }
    const action = json.data?.contractAction;
    return {
      ok: Boolean(action?.transaction?.hash),
      detail: action?.transaction?.hash ? "contract action found on the indexer" : "no contract action yet",
      blockHeight: action?.transaction?.block?.height ?? null,
      txHash: action?.transaction?.hash ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : "indexer unreachable",
      blockHeight: null,
      txHash: null,
    };
  }
}

/**
 * Why the indexer has no blocks: reads the indexer's own log and probes the node
 * RPC from inside the node machine (which ships curl). Without this the empty
 * chain is invisible — the GraphQL endpoint answers happily either way.
 */
export async function midnightDiagnostics(appName: string) {
  if (!flyConfigured()) return null;
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  const indexer = machines.find((m) => m.name === "midnight-indexer");
  const node = machines.find((m) => m.name === "midnight-node");

  async function exec(machineId: string, command: string) {
    try {
      const res = await flyOptional<{ exit_code?: number; stdout?: string; stderr?: string }>(
        `/apps/${appName}/machines/${machineId}/exec`,
        { method: "POST", body: JSON.stringify({ command: ["/bin/sh", "-c", command], timeout: 25 }) },
      );
      return `${res?.stdout ?? ""}${res?.stderr ?? ""}`.trim().slice(0, 1200);
    } catch (err) {
      return err instanceof Error ? err.message.slice(0, 300) : "exec failed";
    }
  }

  /**
   * The app log API only answers for org-scoped tokens; with the app-scoped
   * token this project uses it returns 401. Say that plainly instead of
   * printing `log api 401` as if it described the indexer.
   */
  async function appLog(machineId: string) {
    try {
      const res = await fetch(`https://api.fly.io/api/v1/apps/${appName}/logs?instance=${machineId}`, {
        headers: { Authorization: `Bearer ${token()}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: { attributes?: { message?: string } }[] };
      const lines = (json.data ?? []).map((d) => d.attributes?.message ?? "").filter(Boolean);
      return lines.slice(-40).join("\n").slice(-2000) || null;
    } catch {
      return null;
    }
  }

  /**
   * Container log via exec, for images whose stdout we cannot fetch. Tries the
   * usual log locations and reports "no log file in this image" rather than an
   * empty string, so the timeline never implies an empty log means "healthy".
   */
  async function execLog(machineId: string) {
    const out = await exec(
      machineId,
      `for f in /var/log/*.log /tmp/*.log; do [ -f "$f" ] && tail -c 1500 "$f"; done 2>/dev/null || true`,
    );
    return out || null;
  }

  /** Works on toolless images: curl → wget → nc, else say the probe cannot run. */
  function reach(label: string, url: string, hostPort: string) {
    return `if command -v curl >/dev/null 2>&1; then echo "${label}=$(curl -sk -m 8 -o /dev/null -w '%{http_code}' ${url})"; \
elif command -v wget >/dev/null 2>&1; then wget -q -T 8 -O /dev/null ${url} && echo "${label}=reachable" || echo "${label}=unreachable"; \
elif command -v nc >/dev/null 2>&1; then nc -z -w 8 ${hostPort} && echo "${label}=tcp-open" || echo "${label}=tcp-closed"; \
else echo "${label}=probe-unavailable-in-this-image"; fi`;
  }

  const edgeHost = `${appName}.fly.dev`;

  return {
    indexerLog: indexer ? ((await appLog(indexer.id)) ?? (await execLog(indexer.id))) : null,
    nodeLog: node ? ((await appLog(node.id)) ?? (await execLog(node.id))) : null,
    // Public IPs / flycast, read back from Fly rather than assumed.
    ips: await appIpSummary(appName),
    // Does the node's RPC answer locally, and through the edge the indexer dials?
    nodeRpcFromNode: node
      ? await exec(
          node.id,
          `${reach("local", "http://127.0.0.1:9944/health", "127.0.0.1 9944")}; ${reach("edge", `https://${edgeHost}:9944/health`, `${edgeHost} 9944`)}`,
        )
      : null,
    nodeRpcFromIndexer: indexer
      ? await exec(indexer.id, reach("edge", `https://${edgeHost}:9944/health`, `${edgeHost} 9944`))
      : null,
    machines: machines.map((m) => ({ name: m.name, state: m.state, ...exitSummary(m) })),
  };
}

/* ------------------------------------------------------------------ runner --

   Helpers used by runner.server.ts. They live here because the Machines API
   client (`fly`, `flyOptional`, the auth token) is module-private.
   ------------------------------------------------------------------------- */

/** Looks up a machine by name. `null` means the machine does not exist. */
export async function findMachineByName(
  appName: string,
  name: string,
): Promise<{ id: string; state: string } | null> {
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  const m = machines.find((x) => x.name === name);
  return m ? { id: m.id, state: m.state } : null;
}

/** Creates or re-applies the runner machine and waits for it to be startable. */
export async function ensureRunnerMachine(appName: string, region: string) {
  const m = await ensureMachine(appName, "runner", region);
  await flyOptional(`/apps/${appName}/machines/${m.id}/wait?state=started&timeout=60`);
  const current = await findMachineByName(appName, RUNNER.machine);
  return current ?? { id: m.id, state: m.state ?? "created" };
}

/** A stopped runner cannot be exec'd into; start it before running a job. */
export async function startMachine(appName: string, machineId: string) {
  await flyOptional(`/apps/${appName}/machines/${machineId}/start`, { method: "POST" });
  await flyOptional(`/apps/${appName}/machines/${machineId}/wait?state=started&timeout=60`);
}

export type ExecResult = { exitCode: number | null; output: string };

/**
 * Runs a shell command inside a machine. Fly caps exec at ~30s, so every
 * long-running job is launched detached and polled instead of awaited.
 */
export async function execOnMachine(
  appName: string,
  machineId: string,
  command: string,
  timeoutSec = 25,
): Promise<ExecResult> {
  const res = await fly<{ exit_code?: number; stdout?: string; stderr?: string }>(
    `/apps/${appName}/machines/${machineId}/exec`,
    {
      method: "POST",
      body: JSON.stringify({ command: ["/bin/sh", "-c", command], timeout: timeoutSec }),
      timeoutMs: (timeoutSec + 10) * 1000,
    },
  );
  return {
    exitCode: typeof res.exit_code === "number" ? res.exit_code : null,
    output: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}
