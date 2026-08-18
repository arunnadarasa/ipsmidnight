#!/usr/bin/env node
/**
 * Read-only ledger membership check for an IPS anchor commitment.
 *
 * Unlike deploy/anchor this needs no wallet, no proof server and no private
 * state: it queries the indexer for the contract's public state and asks the
 * generated `ledger()` view whether the commitment is actually in the on-chain
 * Set. "A transaction exists" is NOT verification — this is.
 *
 * Usage:
 *   bun scripts/verify-midnight.mjs --indexer https://<app>.fly.dev/api/v4/graphql \
 *                                   --commitment <64-hex> [--address <addr>] [--out result.json]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import WebSocket from "ws";

globalThis.WebSocket = WebSocket;

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1]]] : [])),
);

const INDEXER = args.indexer ?? process.env.VITE_INDEXER_URL;
if (!INDEXER) {
  console.error("Missing --indexer (or VITE_INDEXER_URL).");
  process.exit(1);
}
const INDEXER_WS = INDEXER.replace(/^http/, "ws") + "/ws";

const COMMITMENT = (args.commitment ?? "").toLowerCase().replace(/^0x/, "");
if (!/^[0-9a-f]{64}$/.test(COMMITMENT)) {
  console.error("Missing or malformed --commitment (expected 32-byte hex).");
  process.exit(1);
}

const PROJECT = resolve(args.project ?? process.cwd());
const CONTRACT_DIR = resolve(PROJECT, "contracts/managed/ips-anchor-registry");
const DEPLOY_FILE = resolve(PROJECT, "src/data/midnight-contract.undeployed.json");
const deployInfo = existsSync(DEPLOY_FILE) ? JSON.parse(readFileSync(DEPLOY_FILE, "utf8")) : {};
const CONTRACT_ADDRESS = args.address ?? deployInfo.address;
if (!CONTRACT_ADDRESS || /^0+$/.test(CONTRACT_ADDRESS)) {
  console.error("No deployed contract address — run scripts/deploy-midnight.mjs first.");
  process.exit(1);
}

const RESULT_FILE = args.out ? resolve(args.out) : null;
function writeResult(payload) {
  if (!RESULT_FILE) return;
  try {
    writeFileSync(RESULT_FILE, `${JSON.stringify(payload)}\n`);
  } catch (err) {
    console.error("could not write result file:", err);
  }
}

async function main() {
  const { setNetworkId } = await import("@midnight-ntwrk/midnight-js-network-id");
  setNetworkId("undeployed");

  const { indexerPublicDataProvider } = await import("@midnight-ntwrk/midnight-js-indexer-public-data-provider");
  const contractEntry = existsSync(`${CONTRACT_DIR}/contract/index.js`)
    ? `${CONTRACT_DIR}/contract/index.js`
    : `${CONTRACT_DIR}/contract/index.cjs`;
  const contractModule = await import(pathToFileURL(contractEntry).href);
  const ledgerView = contractModule.ledger ?? contractModule.default?.ledger;
  if (typeof ledgerView !== "function") throw new Error("generated contract exposes no ledger() view");

  const publicDataProvider = indexerPublicDataProvider(INDEXER, INDEXER_WS);
  const contractState = await publicDataProvider.queryContractState(CONTRACT_ADDRESS);
  if (!contractState) throw new Error(`contract ${CONTRACT_ADDRESS} not found on the indexer`);

  const view = ledgerView(contractState.data ?? contractState.state ?? contractState);
  const commitmentBytes = Uint8Array.from(Buffer.from(COMMITMENT, "hex"));
  const member = Boolean(view.commitments.member(commitmentBytes));
  const anchorCount = Number(view.anchor_count ?? 0);
  const lastCommitment = Buffer.from(view.last_commitment ?? new Uint8Array()).toString("hex");
  const blockHeight = contractState.blockHeight ?? null;

  writeResult({
    ok: true,
    member,
    commitment: COMMITMENT,
    anchorCount,
    lastCommitment,
    blockHeight,
    contractAddress: CONTRACT_ADDRESS,
  });
  console.log(
    `VERIFY_${member ? "OK" : "MISS"} commitment=${COMMITMENT.slice(0, 12)}… anchors=${anchorCount}`,
  );
}

main().catch((err) => {
  console.error(err);
  writeResult({ ok: false, error: String(err?.message ?? err).slice(0, 800) });
  process.exit(1);
});
