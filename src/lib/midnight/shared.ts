/** Constants shared by the Fly provisioner, the deploy script and the UI. */
export const MIDNIGHT_NETWORK = "undeployed" as const;

export const IMAGES = {
  // Tags taken from the official midnight-local-dev `standalone.yml`; older
  // 0.22.x node builds reject the dev preset arguments and exit 1 in a loop.
  node: "docker.io/midnightntwrk/midnight-node:1.0.0",
  indexer: "docker.io/midnightntwrk/indexer-standalone:4.3.3",
  // Pinned: `latest` has shipped incompatible proving keys mid-demo.
  proof: "docker.io/midnightntwrk/proof-server:8.1.0",
  // Plain Node image: the runner installs the Midnight SDK onto its volume at
  // bootstrap, so no custom image has to be built or pushed anywhere.
  runner: "docker.io/library/node:22-bookworm-slim",
} as const;

/** Installed in order, one `npm install` per group. */
const DEP_GROUPS = [
  [
    "@midnight-ntwrk/midnight-js-network-id@4.1.1",
    "@midnight-ntwrk/midnight-js-utils@4.1.1",
    "ws",
  ],
  [
    "@midnight-ntwrk/midnight-js-contracts@4.1.1",
    "@midnight-ntwrk/midnight-js-node-zk-config-provider@4.1.1",
    "@midnight-ntwrk/midnight-js-level-private-state-provider@4.1.1",
    "@midnight-ntwrk/midnight-js-http-client-proof-provider@4.1.1",
    "@midnight-ntwrk/midnight-js-indexer-public-data-provider@4.1.1",
  ],
  [
    // compact-js is versioned independently of midnight-js 4.x and is not a
    // transitive dependency of midnight-js-contracts, so it needs its own pin.
    // 2.5.1, NOT 2.5.3: the 2.5.3 release declares
    // `@midnight-ntwrk/ledger-v9@^0.1.0-alpha.1`, a range that was never
    // published (only 1.0.0-rc.x exists), so npm fails with ETARGET. 2.5.1 is
    // also what midnight-js-protocol@4.1.1 resolves for itself, so the runner
    // ends up with a single copy.
    "@midnight-ntwrk/compact-js@2.5.1",
    "@midnight-ntwrk/zswap@4.0.0",
  ],
  ["@midnight-ntwrk/wallet-sdk@1.2.0", "@midnight-ntwrk/testkit-js@4.1.1"],
] as const;


/**
 * The runner machine executes scripts/deploy-midnight.mjs and
 * scripts/anchor-midnight.mjs. Proving needs a long-lived proof-server session,
 * a wallet and a LevelDB private-state store on disk — none of which the
 * serverless app runtime has — so the same scripts run here instead.
 */
export const RUNNER = {
  machine: "midnight-runner",
  volume: "midnight_runner",
  /** Volume mount point; holds node_modules, artifacts, private state and logs. */
  work: "/work",
  /** Extracted artifact bundle; also the cwd of every job (LevelDB lives here). */
  app: "/work/app",
  logs: "/work/logs",
  out: "/work/out",
  /** Bump when the compiled contract or the scripts change so runners re-bootstrap. */
  // Bumped when the SDK pins change so an already-"prepared" runner re-installs
  // instead of being skipped with a half-broken node_modules on its volume.
  artifactVersion: "ips-anchor-registry-3",
  bucket: "midnight-artifacts",
  /** Object key inside the bucket; uploaded once from the build sandbox. */
  object: "ips-anchor-registry-2.tgz",
  /** LevelDB store name — shared by every anchor; the contract keeps no per-user state. */
  store: "ips-midnight-level-db",
  /**
   * Pinned SDK versions, identical to the header of scripts/deploy-midnight.mjs,
   * split into groups. One `npm install` of the whole set peaked the runner's
   * memory and was killed mid-install with no error; smaller groups keep the
   * peak down, let a retry reuse what is already on the volume, and give the UI
   * something to advance through during the long phase.
   */
  depGroups: DEP_GROUPS,
  /** Flattened view, for anything that just needs the full list. */
  deps: DEP_GROUPS.flat(),
} as const;


/** Indexer 4.x refuses to boot unless every APP__INFRA__ key is present. */
export const INDEXER_ENV = {
  APP__APPLICATION__NETWORK_ID: "undeployed",
  APP__INFRA__STORAGE__PASSWORD: "indexer",
  APP__INFRA__PUB_SUB__PASSWORD: "indexer",
  APP__INFRA__LEDGER_STATE_STORAGE__PASSWORD: "indexer",
  APP__INFRA__SECRET:
    "303132333435363738393031323334353637383930313233343536373839303132",
  APP__INFRA__SPO_NODE__BLOCKFROST_ID: "e2e-test-dummy-id",
  // Fly's 6PN network is IPv6-only: bind the GraphQL API to all IPv6 addresses.
  APP__INFRA__API__ADDRESS: "::",
} as const;

/**
 * Address of the node's RPC, used by both indexer node URLs.
 *
 * NOT the 6PN `<group>.process.<app>.internal` name: that resolves to IPv6 only,
 * while the node's RPC listener binds IPv4, so an IPv6 connect is refused and
 * the indexer silently serves an empty chain. `<app>.flycast` was the next
 * attempt, but it depends on a private-IP allocation that can silently be
 * missing — the observed failure was `000` on flycast even from inside the app.
 *
 * The Fly edge always terminates on IPv4 inside the container, needs no private
 * IP, and works from any machine, so the node RPC is published on 9944 and both
 * the indexer and the deploy script dial it over TLS. The chain is a throwaway
 * `CFG_PRESET=dev` chain with no funds, so a public dev RPC is acceptable here.
 */
export function nodeRpcWsUrl(appName: string) {
  return `wss://${appName}.fly.dev:9944`;
}



export const FLY_REGIONS = [
  { code: "lhr", label: "London" },
  { code: "fra", label: "Frankfurt" },
  { code: "iad", label: "Ashburn, US" },
  { code: "sjc", label: "San Jose, US" },
  { code: "syd", label: "Sydney" },
] as const;

export type StackUrls = {
  appName: string;
  indexerUrl: string;
  indexerWsUrl: string;
  proofUrl: string;
  nodeUrl: string;
};

export function stackUrls(appName: string): StackUrls {
  const host = `${appName}.fly.dev`;
  return {
    appName,
    indexerUrl: `https://${host}/api/v4/graphql`,
    indexerWsUrl: `wss://${host}/api/v4/graphql/ws`,
    proofUrl: `https://${host}:6300`,
    // The node's RPC is 6PN-internal only (no public port) — reachable from
    // other Fly apps and from a one-shot deploy machine on the same network.
    nodeUrl: nodeRpcWsUrl(appName),
  };
}

/** Domain separator for the IPS anchor commitment (must stay <= 32 bytes). */
export const IPS_DOMAIN = "ips:anchor:v1";
