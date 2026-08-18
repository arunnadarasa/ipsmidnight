#!/usr/bin/env node
/**
 * Deploy IpsAnchorRegistry to the Fly-hosted Midnight Undeployed stack.
 *
 * This is a LOCAL/sandbox Node script on purpose: the serverless runtime has no
 * long-lived connection to a proof server and cannot host a wallet.
 *
 * Prerequisites (one time):
 *   compact compile contracts/IpsAnchorRegistry.compact contracts/managed/ips-anchor-registry
 *   bun add @midnight-ntwrk/midnight-js-contracts@4.1.1 \
 *           @midnight-ntwrk/midnight-js-node-zk-config-provider@4.1.1 \
 *           @midnight-ntwrk/midnight-js-level-private-state-provider@4.1.1 \
 *           @midnight-ntwrk/midnight-js-http-client-proof-provider@4.1.1 \
 *           @midnight-ntwrk/midnight-js-indexer-public-data-provider@4.1.1 \
 *           @midnight-ntwrk/midnight-js-utils@4.1.1 \
 *           @midnight-ntwrk/wallet-sdk@1.2.0 @midnight-ntwrk/testkit-js@4.1.1 \
 *           @midnight-ntwrk/zswap@4.0.0 ws
 *
 * Usage:
 *   bun scripts/deploy-midnight.mjs --indexer https://<app>.fly.dev/api/v4/graphql \
 *                                   --proof   https://<app>.fly.dev:6300
 */
import { writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import WebSocket from "ws";

globalThis.WebSocket = WebSocket;

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1]]] : [])),
);

const INDEXER = args.indexer ?? process.env.VITE_INDEXER_URL;
const PROOF = args.proof ?? process.env.VITE_PROOF_SERVER_URL;
if (!INDEXER || !PROOF) {
  console.error("Missing --indexer and/or --proof (or VITE_INDEXER_URL / VITE_PROOF_SERVER_URL).");
  process.exit(1);
}
const INDEXER_WS = INDEXER.replace(/^http/, "ws") + "/ws";

// Shared with the app so private state survives redeploys — never randomise these.
const GENESIS_SEED = "0000000000000000000000000000000000000000000000000000000000000002";
const PRIVATE_STATE_ID = "ips-anchor-registry";
const PRIVATE_STATE_STORE = "ips-midnight-level-db";
// midnight-js-utils enforces >= 16 characters and mixed character classes.
const PRIVATE_STORAGE_PASSWORD = "Ips-Anchor-Registry-2026";
const DEPLOYER_SECRET_HEX = "11".repeat(32);

// The Midnight JS SDK is ESM-only and heavy; it is installed in a scratch
// folder rather than the app's package.json, so the script may be copied next
// to that node_modules and pointed back at the repo with --project.
const PROJECT = resolve(args.project ?? process.cwd());
const CONTRACT_DIR = resolve(PROJECT, "contracts/managed/ips-anchor-registry");
const OUT_FILE = resolve(PROJECT, "src/data/midnight-contract.undeployed.json");
// `--out` makes the run machine-readable: the console's runner polls this file
// to learn whether the job succeeded, instead of scraping stdout.
const RESULT_FILE = args.out ? resolve(args.out) : null;
function writeResult(payload) {
  if (!RESULT_FILE) return;
  try {
    writeFileSync(RESULT_FILE, `${JSON.stringify(payload)}\n`);
  } catch (err) {
    console.error("could not write result file:", err);
  }
}
if (!existsSync(`${CONTRACT_DIR}/contract/index.js`) && !existsSync(`${CONTRACT_DIR}/contract/index.cjs`)) {
  console.error(`Compile first: compact compile contracts/IpsAnchorRegistry.compact ${CONTRACT_DIR}`);
  process.exit(1);
}

async function waitForStack() {
  for (let i = 0; i < 60; i += 1) {
    const [indexerOk, proofOk] = await Promise.all([
      fetch(INDEXER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "query { block { height } }" }),
      })
        .then((r) => r.ok)
        .catch(() => false),
      fetch(`${PROOF}/health`).then((r) => r.ok).catch(() => false),
    ]);
    if (indexerOk && proofOk) return;
    console.log(`waiting for stack… indexer=${indexerOk} proof=${proofOk}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Stack never became ready — check the Fly machines.");
}

async function main() {
  await waitForStack();

  // Every SDK package here is ESM-only: several ship no dist/cjs build, so
  // require() fails with MODULE_NOT_FOUND on @midnight-ntwrk/compact-js.
  const { setNetworkId } = await import("@midnight-ntwrk/midnight-js-network-id");
  setNetworkId("undeployed");

  const { deployContract } = await import("@midnight-ntwrk/midnight-js-contracts");
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

  // The proof server needs the circuit's IR alongside the preimage; without
  // the zkConfigProvider argument /check answers 400 Bad Request.
  const zkConfigProvider = new NodeZkConfigProvider(CONTRACT_DIR);

  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: PRIVATE_STATE_STORE,
      accountId: PRIVATE_STATE_ID,
      privateStoragePasswordProvider: () => PRIVATE_STORAGE_PASSWORD,
    }),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(PROOF, zkConfigProvider),
    publicDataProvider: indexerPublicDataProvider(INDEXER, INDEXER_WS),
    walletProvider: wallet,
    midnightProvider: wallet,
  };

  const witnesses = {
    localSecretKey: () => [{}, Uint8Array.from(Buffer.from(DEPLOYER_SECRET_HEX, "hex"))],
  };

  // midnight-js 4.x takes a compact-js CompiledContract binding, not a raw
  // `new Contract(witnesses)` instance.
  const { CompiledContract } = await import("@midnight-ntwrk/compact-js");
  const compiledContract = CompiledContract.make(PRIVATE_STATE_ID, Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(CONTRACT_DIR),
  );

  console.log("deploying IpsAnchorRegistry (first proof can take 30–120s)…");
  const deployed = await deployContract(providers, {
    privateStateId: PRIVATE_STATE_ID,
    compiledContract,
    initialPrivateState: {},
  });

  const address = deployed.deployTxData.public.contractAddress;
  const deployTx = deployed.deployTxData.public.txId ?? null;

  writeFileSync(
    OUT_FILE,
    `${JSON.stringify(
      {
        address,
        deployTx,
        network: "undeployed",
        privateStateId: PRIVATE_STATE_ID,
        circuit: "anchorSummary",
        compactVersion: "0.23",
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  writeResult({ ok: true, address, deployTx });
  console.log(`DEPLOY_OK address=${address} tx=${deployTx}`);
  await wallet.close?.();
}

main().catch((err) => {
  console.error(err);
  writeResult({ ok: false, error: String(err?.message ?? err).slice(0, 800) });
  process.exit(1);
});
