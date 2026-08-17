#!/usr/bin/env node
/**
 * Submit one queued anchor to the deployed IpsAnchorRegistry.
 *
 * Same rationale as scripts/deploy-midnight.mjs: proving needs a long-lived
 * connection to the proof server and a local wallet, so this runs as a
 * sandbox/local Node script rather than in the serverless runtime.
 *
 * Usage:
 *   bun scripts/anchor-midnight.mjs --commitment <64-hex> \
 *     --indexer https://<app>.fly.dev/api/v4/graphql \
 *     --proof   https://<app>.fly.dev:6300 \
 *     --node    wss://<app>.fly.dev:9944
 */
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import WebSocket from "ws";

globalThis.WebSocket = WebSocket;

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1]]] : [])),
);

const INDEXER = args.indexer ?? process.env.VITE_INDEXER_URL;
const PROOF = args.proof ?? process.env.VITE_PROOF_SERVER_URL;
const COMMITMENT = (args.commitment ?? "").replace(/^0x/, "");
if (!INDEXER || !PROOF) {
  console.error("Missing --indexer and/or --proof.");
  process.exit(1);
}
if (!/^[0-9a-f]{64}$/.test(COMMITMENT)) {
  console.error("Missing/invalid --commitment (expected 64 hex chars).");
  process.exit(1);
}
const INDEXER_WS = INDEXER.replace(/^http/, "ws") + "/ws";

// Must match scripts/deploy-midnight.mjs exactly, or the private state the
// deploy wrote cannot be reloaded (RpcError 117 / missing private state).
const GENESIS_SEED = "0000000000000000000000000000000000000000000000000000000000000002";
const PRIVATE_STATE_ID = "ips-anchor-registry";
const PRIVATE_STATE_STORE = "ips-midnight-level-db";
const PRIVATE_STORAGE_PASSWORD = "Ips-Anchor-Registry-2026";
const DEPLOYER_SECRET_HEX = "11".repeat(32);

const PROJECT = resolve(args.project ?? process.cwd());
const CONTRACT_DIR = resolve(PROJECT, "contracts/managed/ips-anchor-registry");
const DEPLOY_FILE = resolve(PROJECT, "src/data/midnight-contract.undeployed.json");
const deployInfo = JSON.parse(readFileSync(DEPLOY_FILE, "utf8"));
const CONTRACT_ADDRESS = args.address ?? deployInfo.address;
if (!CONTRACT_ADDRESS || /^0+$/.test(CONTRACT_ADDRESS)) {
  console.error("No deployed contract address — run scripts/deploy-midnight.mjs first.");
  process.exit(1);
}

async function main() {
  const { setNetworkId } = await import("@midnight-ntwrk/midnight-js-network-id");
  setNetworkId("undeployed");

  const { findDeployedContract } = await import("@midnight-ntwrk/midnight-js-contracts");
  const { NodeZkConfigProvider } = await import("@midnight-ntwrk/midnight-js-node-zk-config-provider");
  const { levelPrivateStateProvider } = await import("@midnight-ntwrk/midnight-js-level-private-state-provider");
  const { httpClientProofProvider } = await import("@midnight-ntwrk/midnight-js-http-client-proof-provider");
  const { indexerPublicDataProvider } = await import("@midnight-ntwrk/midnight-js-indexer-public-data-provider");
  const { MidnightWalletProvider } = await import("@midnight-ntwrk/testkit-js");
  const walletSdk = await import("@midnight-ntwrk/wallet-sdk");

  const contractEntry = existsSync(`${CONTRACT_DIR}/contract/index.js`)
    ? `${CONTRACT_DIR}/contract/index.js`
    : `${CONTRACT_DIR}/contract/index.cjs`;
  const contractModule = await import(pathToFileURL(contractEntry).href);
  const Contract = contractModule.Contract ?? contractModule.default?.Contract;

  const NetworkIds = walletSdk.NetworkId?.NetworkId ?? walletSdk.NetworkId;
  const NODE_RPC = args.node ?? INDEXER.replace(/\/api\/v4\/graphql$/, "") + ":9944";
  const env = {
    walletNetworkId: NetworkIds.Undeployed,
    networkId: "undeployed",
    indexer: INDEXER,
    indexerWS: INDEXER_WS,
    node: NODE_RPC,
    nodeWS: NODE_RPC.replace(/^http/, "ws"),
    proofServer: PROOF,
    faucet: undefined,
  };
  const log = {
    info: (...a) => console.log("[wallet]", ...a),
    warn: (...a) => console.warn("[wallet]", ...a),
    error: (...a) => console.error("[wallet]", ...a),
    debug: () => {},
    trace: () => {},
  };

  const wallet = await MidnightWalletProvider.build(log, env, GENESIS_SEED);
  await wallet.start(true);

  const privateStateProvider = levelPrivateStateProvider({
    privateStateStoreName: PRIVATE_STATE_STORE,
    accountId: PRIVATE_STATE_ID,
    privateStoragePasswordProvider: () => PRIVATE_STORAGE_PASSWORD,
  });
  await privateStateProvider.setContractAddress?.(CONTRACT_ADDRESS);

  // The proof server needs the circuit's IR alongside the preimage; without
  // the zkConfigProvider argument /check answers 400 Bad Request.
  const zkConfigProvider = new NodeZkConfigProvider(CONTRACT_DIR);

  const providers = {
    privateStateProvider,
    zkConfigProvider,
    proofProvider: httpClientProofProvider(PROOF, zkConfigProvider),
    publicDataProvider: indexerPublicDataProvider(INDEXER, INDEXER_WS),
    walletProvider: wallet,
    midnightProvider: wallet,
  };

  const witnesses = {
    localSecretKey: () => [{}, Uint8Array.from(Buffer.from(DEPLOYER_SECRET_HEX, "hex"))],
  };

  const { CompiledContract } = await import("@midnight-ntwrk/compact-js");
  const compiledContract = CompiledContract.make(PRIVATE_STATE_ID, Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(CONTRACT_DIR),
  );

  const found = await findDeployedContract(providers, {
    contractAddress: CONTRACT_ADDRESS,
    compiledContract,
    privateStateId: PRIVATE_STATE_ID,
  });

  console.log(`anchoring commitment ${COMMITMENT.slice(0, 12)}… (proving takes 30–120s)…`);
  const commitmentBytes = Uint8Array.from(Buffer.from(COMMITMENT, "hex"));
  const called = await found.callTx.anchorSummary(commitmentBytes);
  const txId = called.public?.txId ?? called.txId ?? null;
  const blockHeight = called.public?.blockHeight ?? null;

  console.log(`ANCHOR_OK tx=${txId} block=${blockHeight}`);
  await wallet.close?.();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
