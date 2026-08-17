import { IMAGES, INDEXER_ENV, nodeRpcWsUrl, stackUrls, type StackUrls } from "./shared";

const MACHINES_API = "https://api.machines.dev/v1";

const NODE_VOLUME = "midnight_chain";
const NODE_DATA_PATH = "/node/chain";

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


function token() {
  const t = process.env["FLY_API_TOKEN"];
  if (!t) throw new Error("FLY_API_TOKEN is not configured for this project.");
  return t;
}

async function fly<T>(path: string, init?: RequestInit & { raw?: boolean }): Promise<T> {
  const res = await fetch(`${MACHINES_API}${path}`, {
    ...init,
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

/** Public IPs are allocated through the GraphQL API, not the Machines API. */
async function allocateIps(appName: string) {
  const mutation = `mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { address type } } }`;
  for (const type of ["shared_v4", "v6"] as const) {
    const res = await fetch("https://api.fly.io/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: mutation, variables: { input: { appId: appName, type } } }),
    });
    // Already-allocated IPs return an error we can safely ignore.
    await res.text();
  }
}

function machineConfig(
  kind: "node" | "indexer" | "proof",
  appName: string,
  volumeId?: string | null,
) {
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
        // 9944 is never published publicly, but it MUST be declared as a service
        // so the Fly proxy accepts private (flycast) traffic on that port and
        // forwards it to the container over IPv4 — the only way the indexer can
        // reach an IPv4-bound Substrate RPC on Fly's IPv6-only 6PN network.
        services: [
          {
            ports: [{ port: 9944, handlers: [] }],
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
 * Reuses an existing chain volume in the region or creates one. Returns null on
 * failure so a missing volume degrades to ephemeral chain data rather than
 * blocking the whole provision.
 */
async function ensureNodeVolume(appName: string, region: string): Promise<string | null> {
  try {
    const volumes =
      (await flyOptional<{ id: string; name: string; region: string }[]>(`/apps/${appName}/volumes`)) ?? [];
    const existing = volumes.find((v) => v.name === NODE_VOLUME && v.region === region);
    if (existing) return existing.id;
    const created = await fly<{ id: string }>(`/apps/${appName}/volumes`, {
      method: "POST",
      body: JSON.stringify({ name: NODE_VOLUME, region, size_gb: 10 }),
    });
    return created.id;
  } catch {
    return null;
  }
}

async function ensureMachine(
  appName: string,
  kind: "node" | "indexer" | "proof",
  region: string,
): Promise<FlyMachine> {
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  const volumeId = kind === "node" ? await ensureNodeVolume(appName, region) : null;
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
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  const repaired: string[] = [];
  for (const kind of ["node", "indexer", "proof"] as const) {
    const volumeId = kind === "node" ? await ensureNodeVolume(appName, region) : null;
    const spec = machineConfig(kind, appName, volumeId);
    const body = machineBody(spec as { name: string; config: Record<string, unknown> }, region);
    const existing = machines.find((m) => m.name === spec.name);
    if (existing) {
      await fly(`/apps/${appName}/machines/${existing.id}`, { method: "POST", body });
      await flyOptional(`/apps/${appName}/machines/${existing.id}/restart`, { method: "POST" });
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
  for (const kind of ["node", "indexer", "proof"] as const) {
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

export async function machineStates(appName: string) {
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
    return {
      probe: {
        ok: res.ok && !json.errors,
        status: res.status,
        detail: height === null ? "reachable, no block yet" : `block #${height}`,
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
