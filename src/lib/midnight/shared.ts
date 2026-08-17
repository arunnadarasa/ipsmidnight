/** Constants shared by the Fly provisioner, the deploy script and the UI. */
export const MIDNIGHT_NETWORK = "undeployed" as const;

export const IMAGES = {
  // Tags taken from the official midnight-local-dev `standalone.yml`; older
  // 0.22.x node builds reject the dev preset arguments and exit 1 in a loop.
  node: "docker.io/midnightntwrk/midnight-node:1.0.0",
  indexer: "docker.io/midnightntwrk/indexer-standalone:4.3.3",
  // Pinned: `latest` has shipped incompatible proving keys mid-demo.
  proof: "docker.io/midnightntwrk/proof-server:8.1.0",
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
