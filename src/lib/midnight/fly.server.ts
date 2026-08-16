import { IMAGES, INDEXER_ENV, stackUrls, type StackUrls } from "./shared";

const MACHINES_API = "https://api.machines.dev/v1";

type FlyMachine = { id: string; name: string; state: string; region?: string };

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

function machineConfig(kind: "node" | "indexer" | "proof", appName: string) {
  if (kind === "node") {
    return {
      name: "midnight-node",
      region: undefined,
      config: {
        image: IMAGES.node,
        env: {
          CFG_PRESET: "dev",
          RUST_LOG: "info",
          SHOW_CONFIG: "false",
        },
        guest: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
        services: [
          {
            ports: [
              { port: 9944, handlers: ["tls", "http"] },
            ],
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
          APP__INFRA__NODE__URL: `ws://midnight-node.process.${appName}.internal:9944`,
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

async function ensureMachine(
  appName: string,
  kind: "node" | "indexer" | "proof",
  region: string,
): Promise<FlyMachine> {
  const spec = machineConfig(kind, appName);
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  const existing = machines.find((m) => m.name === spec.name);
  if (existing) {
    await fly(`/apps/${appName}/machines/${existing.id}`, {
      method: "POST",
      body: JSON.stringify({ name: spec.name, region, config: spec.config }),
    });
    return { ...existing, state: "updating" };
  }
  return fly<FlyMachine>(`/apps/${appName}/machines`, {
    method: "POST",
    body: JSON.stringify({ name: spec.name, region, config: spec.config }),
  });
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

export async function machineStates(appName: string) {
  const machines = (await flyOptional<FlyMachine[]>(`/apps/${appName}/machines`)) ?? [];
  return machines.map((m) => ({ name: m.name, id: m.id, state: m.state, region: m.region ?? null }));
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
