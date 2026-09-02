---
name: lovable-midnight
description: Ship a Midnight ZK dApp (Compact contract + Lace wallet + local proof server + Indexer reads) in a single Lovable build. Use when the user asks for anything on the Midnight Network — private-by-default smart contracts, zero-knowledge circuits, Lace wallet, tDUST, or "how do I add privacy to my app".
---

# lovable-midnight

Build a Midnight Network dApp in one shot. Midnight is a privacy-first L1 where every smart contract has a public ledger, a ZK circuit, and a local off-chain component. Circuit parameters are **private by default** — you must call `disclose()` to move any value to public state.

## Non-negotiables

- **Compact language `0.23`**, MidnightJS SDK `midnight-js-contracts@4.1.1` + `wallet@4.0.0` + `wallet-sdk-hd@3.1.0-beta.1`, proof server `midnightntwrk/proof-server:latest`.
- Every `.compact` file starts with `pragma language_version 0.23;` and imports `CompactStandardLibrary`.
- Every ledger write from a circuit parameter needs an explicit `disclose(...)` — otherwise the compiler rejects it. This is the whole privacy model; don't work around it.
- `witness` callbacks (private inputs from TypeScript) return values that never touch the chain. Never send the witness value in a transaction — pass it into the circuit only.
- Circuits are bounded: **no recursion, no dynamic-length loops, no I/O, no oracles.** All loops fold over compile-time constants.
- Proofs for medium circuits (`k=14`) take **30–120s** on the local proof server (first proof after container boot is the slowest; warm proofs are seconds). Every write UI must show a `Proving…` state and stay usable.
- **No SSR.** MidnightJS uses `window`, Node `Buffer`, and WASM with top-level await. Load all `@midnight-ntwrk/*` imports behind a client-only boundary; put `import { Buffer } from 'buffer'; (globalThis as any).Buffer = Buffer;` as the very first line of `src/main.tsx` (Vite SPA) OR of a client-only entry that a `<ClientOnly>` gate loads (TanStack Start).
- **Do NOT** attempt bridging to Ethereum, oracle calls inside circuits, or sub-second UX.

## Two live networks

| Network | `VITE_NETWORK_ID` | Address prefix | Faucet | Explorer |
| --- | --- | --- | --- | --- |
| Preview (unstable, resets) | `preview` | `mn_shield-addr_test1…` | `midnight-tmnight-preview.nethermind.dev` | `preview.midnightexplorer.com` |
| Preprod (stable, closer to mainnet) | `preprod` | `mn_shield-addr_preprod1…` / unshielded `mn_addr_preprod1…` | `midnight-tmnight-preprod.nethermind.dev` | `preprod.midnightexplorer.com` |

Both explorers accept a contract address (`/contract/<hex>`) or tx hash (`/tx/<hex>`). Prefer preprod for anything demoed to real users.

## Environment secrets

```
VITE_NETWORK_ID=preprod                                            # or preview
VITE_INDEXER_URL=https://indexer.preprod.midnight.network/api/v4/graphql
VITE_INDEXER_WS_URL=wss://indexer.preprod.midnight.network/api/v4/graphql/ws
VITE_PROOF_SERVER_URL=http://localhost:6300
VITE_DEFAULT_CONTRACT=<hex address printed by first deploy>
```

Optional: `VITE_PINATA_JWT` when the app pins artefacts to IPFS.

## One-time terminal setup (the user does this on their machine)

```bash
# 1. Compact compiler
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
source ~/.bashrc && compact update
compact compile contracts/YourContract.compact contracts/managed/your-contract
cp -r contracts/managed/your-contract/keys ./public/keys
cp -r contracts/managed/your-contract/zkir ./public/zkir

# 2. Proof server — Docker Desktop must be RUNNING first (menubar whale icon).
#    "Cannot connect to the Docker daemon at unix:///.../docker.sock" = Docker Desktop not started.
docker run -d --name midnight-proof-server \
  -p 6300:6300 \
  midnightntwrk/proof-server:latest \
  midnight-proof-server -v

# 3. Verify — expect {"status":"ok","timestamp":"..."}.
curl http://localhost:6300/health

# 4. Lifecycle
docker ps                                    # confirm running + port 6300:6300
docker logs -f midnight-proof-server         # tail
docker stop midnight-proof-server            # pause
docker start midnight-proof-server           # resume (image already pulled)
```

Lace wallet ships from https://www.lace.io/ (Midnight-enabled build). Install → switch network to Preview or Preprod → create/restore wallet → copy the shielded/unshielded address.

## Funding: tNIGHT ≠ tDUST (the #1 support question)

Deploys and shielded txs spend **tDUST**, but the faucet only dispenses **tNIGHT**. Every user hits this once.

**Preferred derivation path — `midnight-wallet-cli`** (community CLI, recommended by Midnight dev-rel in #dev-chat, 27 July 2026). Do NOT hand-roll seed → bech32 with `WalletSeeds` + `createKeystore` + address encoders when a one-liner does it:

```bash
npm i -g midnight-wallet-cli

# --seed = 64-char HEX master seed (32 bytes), NOT a BIP-39 mnemonic
mn address --seed <64-hex-master-seed> --network preprod   # → mn_addr_preprod1…
mn balance <mn_addr_preprod1…> --network preprod
```

`--network` accepts `preprod`, `preview`, `undeployed`, `mainnet`. Prints the UNSHIELDED bech32 (`mn_addr_…`) the faucet wants; shielded (`mn_shield-addr_…`) is a different identity the faucet rejects. Never accept a user's seed in chat — run locally only. Keep `scripts/derive-unshielded-address.mjs` as an offline fallback.

1. Copy your **unshielded** address (`mn_addr_preprod1…`) from Lace or `mn address`.
2. Paste it into the preprod faucet, click Request → you now hold tNIGHT.
3. In Lace, click **Generate tDUST** to delegate tNIGHT and mint tDUST.
4. Refresh — the wallet page should show a tDUST balance. Only now can you deploy.

If a deploy fails with "insufficient tDUST", step 3 was skipped.

References: https://www.npmjs.com/package/midnight-wallet-cli · https://github.com/nel349/midnight-wallet-cli

## The four canonical primitives

| Primitive | When to reach for it | Compact shape |
| --- | --- | --- |
| Compact contract deploy | Public timestamped log of actions | `ledger last_message` + `disclose()` |
| Private witness proof | Prove ownership without revealing identity | `witness sk()` → hash into a `Set` on chain |
| Lace wallet + tDUST | Wallet-first UX, no email flow | `initialAPI.connect(net)` → shielded address |
| IPFS content commit | Big artefacts + on-chain provenance | `Pinata → CID → ledger.last_cid` |

## Canonical Compact contract

```compact
pragma language_version 0.23;
import CompactStandardLibrary;

export ledger entry_count: Counter;
export ledger last_message: Opaque<"string">;
export ledger last_author_commitment: Bytes<32>;

witness localSecretKey(): Bytes<32>;

constructor() { entry_count.increment(1); }

export circuit appendEntry(newMessage: Opaque<"string">): [] {
  const sk = localSecretKey();
  const seq = entry_count as Field as Bytes<32>;
  last_author_commitment = disclose(
    persistentHash<Vector<3, Bytes<32>>>([pad(32, "log:author:"), seq, sk])
  );
  last_message = disclose(newMessage);     // disclose is REQUIRED
  entry_count.increment(1);
}
```

Type-casting rules learned the hard way:
- `Counter → Field → Bytes<32>` is two steps: `x as Field as Bytes<32>`. Direct `as Bytes<32>` fails.
- **String literals in a `constructor()` are `Bytes<N>`, not `Opaque<"string">`.** Do not assign `"(empty)"` to a ledger field of type `Opaque<"string">` — the compiler rejects it. Only `disclose(<circuit-param-of-that-type>)` works.

## Vite config essentials (classic Vite SPA)

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
export default defineConfig({
  build: { target: 'esnext', commonjsOptions: { transformMixedEsModules: true } },
  plugins: [react(), wasm(), topLevelAwait()],
  optimizeDeps: {
    esbuildOptions: { target: 'esnext', supported: { 'top-level-await': true } },
    include: ['@midnight-ntwrk/compact-runtime'],
    exclude: ['@midnight-ntwrk/onchain-runtime-v3',
              '@midnight-ntwrk/onchain-runtime-v3/midnight_onchain_runtime_wasm_bg.wasm'],
  },
});
```

## TanStack Start compatibility (Lovable's current default)

TanStack Start SSR-renders every route by default; MidnightJS crashes under SSR (`window is not defined`, top-level-await, WASM). Rules:

- **Never** import `@midnight-ntwrk/*` at module scope of a route file. Do all MidnightJS work inside `useEffect` or a lazy component behind a `useHydrated()` / `<ClientOnly>` gate.
- Keep the Compact deploy in a **`bun scripts/deploy-midnight.mjs`** Node script that talks to the local proof server on `localhost:6300` — do NOT deploy from a server function (Cloudflare Worker runtime has no Docker, no proof server, no long-lived TCP to localhost).
- Write the deploy result to `src/data/midnight-contract.json` (address, deployTx, network, versions) so the browser can import it as static JSON and hydrate an explorer link.
- Read-only Indexer GraphQL queries are the ONLY Midnight surface safe in a loader / server function — and only against the public Indexer HTTPS endpoint, never through the proof server.

## MidnightJS bootstrap

```ts
// src/main.tsx  — very first line, before ANY other import:
import { Buffer } from 'buffer'; (globalThis as any).Buffer = Buffer;
```

```ts
// src/lib/providers.ts  (client-only)
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import semver from 'semver';

export async function initProviders() {
  const net = import.meta.env.VITE_NETWORK_ID ?? 'preprod';
  setNetworkId(net);
  const lace = await new Promise<any>((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const w = Object.values((window as any).midnight ?? {}).find((x: any) =>
        x && 'apiVersion' in x && semver.satisfies(x.apiVersion, '4.x'));
      if (w) { clearInterval(iv); res(w); }
      else if (Date.now() - t0 > 5000) { clearInterval(iv); rej(new Error('Install Lace: https://www.lace.io/')); }
    }, 100);
  });
  const api = await lace.connect(net);
  const cfg = await api.getConfiguration();
  const zk = new FetchZkConfigProvider(window.location.origin, fetch.bind(window));
  return {
    connectedAPI: api,
    proofProvider: httpClientProofProvider(cfg.proverServerUri ?? import.meta.env.VITE_PROOF_SERVER_URL, zk),
    publicDataProvider: indexerPublicDataProvider(cfg.indexerUri, cfg.indexerWsUri),
    zkConfigProvider: zk,
  };
}
```

## Reading public ledger state (no wallet needed)

```ts
const r = await fetch(import.meta.env.VITE_INDEXER_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: `query($a:HexEncoded!){ contractAction(address:$a){ state } }`,
    variables: { a: contractAddress },
  }),
});
const stateHex = (await r.json()).data?.contractAction?.state;
```

Decode with the compiled contract's `ledger(state)` helper from `contracts/managed/<name>/contract/index.cjs` — but only in a client-only module.

## Deploy status UI pattern

Ship a small panel that imports `src/data/midnight-contract.json` and branches on address. Treat the all-zero address (`0000…0000`) as "not yet deployed":

```tsx
import contract from '@/data/midnight-contract.json';
const PLACEHOLDER = '0'.repeat(64);
const deployed = contract.address && contract.address !== PLACEHOLDER;
const explorer = contract.explorer?.replace(/\/$/, '') ?? 'https://preprod.midnightexplorer.com';
// deployed → link to `${explorer}/contract/${contract.address}` and `${explorer}/tx/${contract.deployTx}`
// not deployed → show the "run bun scripts/deploy-midnight.mjs" hint
```

This lets the marketing page hydrate the moment the user's local deploy script writes the JSON, with no rebuild coordination.

## Failure modes ranked by frequency

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Cannot connect to the Docker daemon at unix:///…/docker.sock` | Docker Desktop app itself isn't running | Open Docker Desktop from Spotlight, wait for the whale menubar icon, re-run `docker run …` |
| `compile error: disclose() required` | Assigning a circuit param straight to a ledger field | Wrap in `disclose(...)` |
| `cannot cast Counter to Bytes<32>` | Direct cast | `x as Field as Bytes<32>` |
| Assigning a string literal to `Opaque<"string">` ledger field in `constructor()` | Literals are `Bytes<N>`, not `Opaque` | Skip the initial assignment or set from a circuit param via `disclose()` |
| Deploy fails "insufficient tDUST" but faucet said success | Faucet gave tNIGHT; you never converted | In Lace click **Generate tDUST** — see funding section |
| `ReferenceError: Buffer is not defined` | Missing Node polyfill | Add the buffer polyfill line as the FIRST line of `src/main.tsx` |
| Contract state undefined after deploy | ZK keys not served to browser | `cp keys public/keys && cp zkir public/zkir` before `vite dev` |
| Proof hangs / times out | Proof server not running, wrong port, or first-boot warm-up | `docker ps` → `curl http://localhost:6300/health`; first proof after boot takes ~30–120s |
| `window is not defined` at build / SSR | MidnightJS at module scope in a TanStack route/loader | Move behind `useEffect` / `useHydrated()`; deploys go through the `bun scripts/deploy-midnight.mjs` Node script, not a server function |
| `Lace not found` | Extension not installed / page loaded before injection | Poll `window.midnight` for 5s before rejecting |
| `Cannot find package 'bip39'` (or `@midnight-ntwrk/*`) running the deploy script | Deploy/derive scripts are Node ESM, not bundled by Vite — every import must be a real dep in `package.json` | `bun add bip39 @midnight-ntwrk/wallet @midnight-ntwrk/wallet-sdk-hd @midnight-ntwrk/midnight-js-network-id @midnight-ntwrk/zswap` before running |
| Deploy prints `mn_addr_preview1...` but Lace shows `mn_shield-addr_test1...` (or vice versa) — user says "addresses don't match" | Preview shielded vs unshielded encoders drifted: one uses the `preview` bech32 suffix, the other the legacy `test` suffix. Lace won't recognize a mixed pair | Derive BOTH addresses through the SAME `NetworkId` value (Preview → `NetworkId.Undeployed`, Preprod → `NetworkId.TestNet`); print expected prefix and hard-fail the script if the emitted bech32 suffix doesn't match |
| User asks you to verify their wallet using their 12/24 recovery words in chat | Recovery phrase = full wallet control; sandbox exfiltration risk | REFUSE. Ship a local-only `scripts/check-midnight-wallet.mjs` that reads `MIDNIGHT_WALLET_SEED` from their shell env and prints only public addresses. Never accept, echo, or log the phrase |

## Network → NetworkId mapping (source of the Preview mismatch)

The MidnightJS `NetworkId` enum does NOT have a `Preview` member. Wrong mapping = wrong bech32 suffix = Lace rejects the address.

| `VITE_NETWORK_ID` | `NetworkId` (from `@midnight-ntwrk/zswap`) | Unshielded prefix | Shielded prefix |
| --- | --- | --- | --- |
| `preview` | `NetworkId.Undeployed` | `mn_addr_undeployed1…` (Lace shows as "Preview") | `mn_shield-addr_undeployed1…` |
| `preprod` / `testnet` | `NetworkId.TestNet` | `mn_addr_test1…` (Lace labels "Preprod") | `mn_shield-addr_test1…` |
| `mainnet` | `NetworkId.MainNet` | `mn_addr1…` | `mn_shield-addr1…` |

Use ONE `NetworkId` variable across both encoders in a script — do not branch per address type. Validate the emitted prefix before writing `src/data/midnight-contract.json`; abort on mismatch rather than deploying to the wrong network.

## Recovery-phrase safety (hard rule)

If the user offers their seed phrase to "just check it in the sandbox", refuse and give them a local script instead:

```js
// scripts/check-midnight-wallet.mjs — runs on the user's machine only
import * as bip39 from 'bip39';
import { NetworkId } from '@midnight-ntwrk/zswap';
// ...derive the same way the deploy script does, from process.env.MIDNIGHT_WALLET_SEED
// PRINT: network, unshielded address, shielded address. NEVER print the seed.
```

Invocation: `MIDNIGHT_WALLET_SEED="word1 word2 ..." bun scripts/check-midnight-wallet.mjs --network=preview`. Never log, echo, or `console.log` the seed; read it once, derive, discard.

## Anti-patterns

- Don't call `initialAPI.connect(...)` without `setNetworkId(...)` first.
- Don't store the 32-byte witness secret on the server or in a cookie — localStorage only.
- Don't pretend a public ledger commitment is private. It's public. Only the witness stays hidden.
- Don't run the write path under SSR / `build:dev` prerender. Read-only Indexer views are SSR-safe; wallet + proof-server writes are not.
- Don't try to deploy from a Cloudflare Worker / TanStack server function — no Docker, no proof-server access, no localhost. Deploys are a local `bun` script.
- Don't hardcode `preview` when the user demoed on `preprod` (or vice versa). Explorer + faucet + indexer URLs all differ.
- Don't accept a user's recovery phrase in chat or run it through the Lovable sandbox — give them a local script that reads the seed from their own shell env.
- Don't derive unshielded and shielded addresses through different `NetworkId` values in the same script — that's the bug that makes Lace say the addresses don't match.
- Don't assume Node scripts under `scripts/` inherit Vite's dep resolution — every `import` must be `bun add`-ed into `package.json`.

## Agentic-commerce overlays (A2A + AP2, UCP, x402 · mUSDC)

Optional overlay on top of the base Midnight stack: every agentic prompt closes with a real Midnight transaction. Three protocols, three Compact contracts, one banner.

### Non-negotiables

1. **Every overlay ends with a Midnight tx.** A2A/UCP/x402 negotiations that don't anchor on-chain are out of scope — the whole point of the overlay is auditability against a Midnight indexer, not off-chain messaging.
2. **mUSDC is a MIMIC token. No peg, no value.** Ship `MidnightUSDC.compact` with a 10-mUSDC faucet cap and NEVER deploy to Mainnet. Every UI that shows an mUSDC balance must render `<ExperimentalAgenticBanner>` and link to `/agentic-experimental`.
3. **Banner is non-dismissible on Mainnet.** On Preview/Preprod/Undeployed it may be collapsible (localStorage key `agentic-banner-ack`), but it must render on every page that touches the overlay.
4. **Compact-witness signing, NOT EIP-712.** Cross-verifying AP2 mandates from this stack against EVM verifiers won't work — buyer/seller/merchant public keys are `persistentHash([pad(32,"<domain>:v1"), sk])`. Domain separators are per-protocol and MUST NOT be reused (`ap2:buyer:v1`, `ucp:merchant:v1`, `musdc:signer:v1`).
5. **Facilitator falls back to `{ simulated: true }` when no contract is deployed.** Never crash at boot for missing config — same demo-fallback contract as the base skill. Return a stub `midnightTxHash: "0xSIMULATED"` and let the UI surface a "simulated" chip.
6. **x402 header casing is literal.** `PAYMENT-SIGNATURE` (request), `PAYMENT-RESPONSE` (response). Send exactly that. Read case-insensitively.
7. **x402 v2 envelope, Midnight scheme.** `scheme: "midnight-mUSDC"`, `network: "midnight:<preview|preprod|undeployed>"`, `amount` in atomic 6-decimal units as a string. The signed payload wraps under `accepted` (echo the full requirement), NOT at the top level.
8. **Nonce is bytes32 random, never reused.** `spent_nonces: Set<Bytes<32>>` on `MidnightUSDC` enforces this on-chain — the client must also generate a fresh nonce per attempt.
9. **RFC 9421 signing keys are anchored on `OrderLedger.recordSigningKey` on first boot.** UCP callers verify signatures against the on-chain fingerprint, not just the discovery doc.

### Contracts (drop into `contracts/`)

| Contract | Purpose | Domain separator |
|---|---|---|
| `MandateVault.compact` | Anchor signed AP2 CartMandate hashes | `ap2:buyer:v1` |
| `OrderLedger.compact`  | Record UCP order hashes + merchant signing-key fingerprint | `ucp:merchant:v1` |
| `MidnightUSDC.compact` | mUSDC mimic token: faucet + EIP-3009-style transfer + spent-nonce set | `musdc:signer:v1` |

All three follow the base skill's rules: `pragma language_version 0.23;`, `import CompactStandardLibrary;`, every ledger write is `disclose(...)`, witness bodies live in TypeScript.

### Server routes (drop into `src/routes/api/public/`)

All routes bypass Lovable's published-site auth gate — verify inputs yourself. Under-load callable, so the facilitator MUST be idempotent per nonce.

- `ap2-anchor.ts` — POST { mandateHash, buyer, seller, amount, proof }; on Undeployed uses the genesis wallet (`…0002`), on Preview/Preprod uses Lace `publishKit`.
- `ucp-discovery.ts` / `ucp-checkout.ts` / `ucp-self-test.ts` — RFC 9421-signed discovery + order recorder + conformance self-test.
- `x402-proxy.ts` / `x402-challenge.ts` / `x402-verify.ts` / `x402-settle.ts` — CORS-safe same-origin proxy, 402 challenge, proof verify against the contract's verifier, and settlement via `MidnightUSDC.transfer`.

### Failure modes specific to the overlay

| Symptom | Cause | Fix |
|---|---|---|
| AP2 verifier rejects a mandate with matching hash | Buyer signed with a different domain separator (e.g. reused `ucp:merchant:v1`) | Use `ap2:buyer:v1` in both the Compact circuit AND the TypeScript witness derivation |
| x402 client gets `invalid_payload` from the facilitator | Sent v1 envelope (`scheme`/`network` at top level) | Wrap under `accepted` — echo the full requirement chosen from `accepts[]` |
| `nonce already spent` on retry | Client reused the nonce after a network hiccup | Generate a fresh `crypto.getRandomValues(new Uint8Array(32))` per attempt; never store-and-replay |
| UCP receipt verifies signature but the on-chain fingerprint is empty | `recordSigningKey` never called on first boot | Call it once from a bootstrap route or the deploy script |
| Facilitator returns a real `midnightTxHash` in preview but the UI shows "simulated" | Response passed through a proxy that dropped `PAYMENT-RESPONSE` | Restore the header in the proxy (`res.headers.set("PAYMENT-RESPONSE", …)`) — it's non-standard, most proxies strip unknown headers |
| Buyer signs an AP2 mandate but `anchorMandate` reverts with `buyer signature invalid` | Buyer public key derived on the client with a different byte layout than the circuit expects | Match exactly: `persistentHash<Vector<2, Bytes<32>>>([pad(32, "ap2:buyer:v1"), sk])` — no extra fields, no different order |
| Mainnet publish attempts an x402/mUSDC path | mUSDC has no peg — this is a real security risk | Gate the overlay off Mainnet entirely; keep the disclaimer banner non-dismissible on Mainnet routes |

### Prompt-catalogue split

For a hackathon prompt bundle, the overlay adds three theme slugs on top of the base 10 disciplines:

- `agentic-a2a-ap2` — 500 ideas (buyer↔seller negotiation flows)
- `agentic-ucp` — 250 ideas (RFC 9421 signed checkout flows)
- `agentic-x402` — 250 ideas (pay-per-call with mUSDC)

Multiply by the 4-network × 3-OS matrix if you're generating full prompt variants.

## 2026-08 update — hard-won lessons from working agentic repos

These rules come from three end-to-end agentic-commerce dApps that reached real on-chain Undeployed anchors ([agenticmidnight](https://github.com/arunnadarasa/agenticmidnight) — AP2 `anchorMandate`, [ucpmidnight](https://github.com/arunnadarasa/ucpmidnight) — UCP `appendEntry`, [x402midnight](https://github.com/arunnadarasa/x402midnight) — x402 + Sepolia + EffectStream `anchorChunk`). Where they contradict older sections, **these rules win**.

### Wallet / SDK stack MUST match the indexer

- Local Undeployed = `indexer-standalone:4.0.2`. Pin to `MidnightWalletProvider` + `@midnight-ntwrk/wallet-sdk@1.2.0` + `@midnight-ntwrk/testkit-js@4.1.1` + `midnight-js-*@4.1.1`. **Do NOT use `@midnight-ntwrk/wallet@5` `WalletBuilder`** — its GraphQL subscriptions (`wallet`, `ProgressUpdate`, `ViewingUpdate`) don't exist on indexer 4.0.2; every deploy fails `Unknown field "wallet" on type "Subscription"`.
- Polyfill Node WebSocket: `import WebSocket from 'ws'; (globalThis as any).WebSocket = WebSocket;`.
- `NetworkId` from `@midnight-ntwrk/midnight-js-network-id` is **type-only** at 4.1.1. Use `setNetworkId("undeployed")` (string literal). Wallet-side runtime enum is nested: `NetworkId.NetworkId.Undeployed` from `wallet-sdk`.
- Compact 0.31 emits ESM `contracts/managed/<name>/contract/index.js`; deploy scripts resolve `.js` first, `.cjs` only as fallback.
- `levelPrivateStateProvider` at 4.1.1 requires a **function** password provider AND an `accountId` — the old `{ get: async () => … }` on the outer providers bag is outdated.

Required `bun add` for a working Node deploy: `@midnight-ntwrk/midnight-js-contracts@4.1.1`, `midnight-js-node-zk-config-provider@4.1.1`, `midnight-js-level-private-state-provider@4.1.1`, `midnight-js-http-client-proof-provider@4.1.1`, `midnight-js-indexer-public-data-provider@4.1.1`, `midnight-js-utils@4.1.1`, `wallet-sdk@1.2.0`, `testkit-js@4.1.1`, `zswap@4.0.0`, `ws`.

### Undeployed writes go through a server route — design for it from day one

```
Undeployed:  UI → POST /api/public/<verb> → genesis wallet (server) → chain
Other nets:  UI → Lace publishKit → chain
Reads:       indexer GraphQL, no wallet needed
```

Lace CANNOT sign on Undeployed. To make server-append reload the deploy-time witness (avoid `RpcError 117`), everything the deploy touched must be reconstructable at append time. Put into `src/lib/midnight-shared.ts` (imported by both `scripts/deploy-midnight.mjs` and every `*.server.ts` file):

- `GENESIS_SEED = "…0002"` (NOT `…0001` — genesis-funds live on 0002).
- Stable `PRIVATE_STATE_ID` (never `Date.now()`).
- Shared `PRIVATE_STATE_STORE` name and `PRIVATE_STORAGE_PASSWORD` (≥ 3 char classes).
- **Deterministic** `DEPLOYER_SECRET_HEX` (not `crypto.getRandomValues`).
- Deterministic buyer/merchant PK: `persistentHash<Vector<2, Bytes<32>>>([pad(32, "<domain>:v1"), sk])`. Domain separators: `ap2:buyer:v1`, `ucp:merchant:v1`, `musdc:signer:v1`, `abodc:author:v1` — never reused across protocols. Domain string must be ≤ 32 UTF-8 bytes or Compact refuses to compile.

Persist `{ contractAddress, deployTxId, privateStateId, buyerPk }` to `src/data/midnight-contract.undeployed.json`. Every server route must call `providers.privateStateProvider.setContractAddress(contractAddress)` BEFORE any get/set.

### Indexer compose env — full `midnight-local-dev/standalone.yml`

Older skill snippets set only `APP__INFRA__NODE__URL`. Indexer 4.0.2 crashes at boot with `missing field 'secret' for key "INFRA"`. Use:

```yaml
indexer:
  image: midnightntwrk/indexer-standalone:4.0.2
  environment:
    APP__INFRA__NODE__URL: ws://node:9944
    APP__APPLICATION__NETWORK_ID: undeployed
    APP__INFRA__STORAGE__PASSWORD: indexer
    APP__INFRA__PUB_SUB__PASSWORD: indexer
    APP__INFRA__LEDGER_STATE_STORAGE__PASSWORD: indexer
    APP__INFRA__SECRET: "303132333435363738393031323334353637383930313233343536373839303132"
    APP__INFRA__SPO_NODE__BLOCKFROST_ID: "placeholder-not-used-standalone"
  ports: ["8088:8088"]
```

GraphQL readiness must use **POST** (GET → 405). Available subscriptions on 4.0.2: `blocks`, `contractActions`, `dustLedgerEvents`, `shieldedTransactions`, `unshieldedTransactions`, `zswapLedgerEvents` (NO `wallet`).

### SSR stub MUST be gated with `apply: "build"`

Top-level rule now: any Vite plugin that swaps `@midnight-ntwrk/*` or `*.server.ts` for stubs must set `apply: "build"`. Without it, `vite dev` local API handlers hit the stub and `/api/public/<verb>` silently returns `{ simulated: true, midnightTxHash: "0xSIMULATED" }`. UIs that show "ANCHORED" from `0xSIMULATED` are bugs, not demo modes — fail loudly in the server route when the contract JSON is missing or `VITE_NETWORK_ID !== "undeployed"`.

### `optimizeDeps.exclude` (ship from day one)

`testkit-js` and `wallet-sdk` pull in Node-only transitives (`pino`, `ws`, `ssh2`, `cpu-features`) that hang the dev server on "Loading…":

```
"@midnight-ntwrk/testkit-js", "@midnight-ntwrk/wallet-sdk",
"@midnight-ntwrk/midnight-js-contracts", "@midnight-ntwrk/midnight-js-http-client-proof-provider",
"@midnight-ntwrk/midnight-js-indexer-public-data-provider", "@midnight-ntwrk/midnight-js-node-zk-config-provider",
"@midnight-ntwrk/midnight-js-level-private-state-provider", "@midnight-ntwrk/midnight-js-network-id",
"@midnight-ntwrk/midnight-js-utils", "@midnight-ntwrk/wallet",
"@midnight-ntwrk/compact-runtime", "@midnight-ntwrk/onchain-runtime-v3",
"pino", "ws", "ssh2", "cpu-features",
```

### Compact-side gotchas

- `pad(32, "<domain>:<role>")` — string must be ≤ 32 UTF-8 bytes. Long product names fail with `cannot pad "…" to length 32`.
- `Opaque<"string">` fields cannot be initialised in `constructor()` with a literal — literals are `Bytes<N>`. Drop the init.

### Definition of done — verify with the indexer, not the SDK

POST to indexer `/api/v4/graphql`: `contractAction(address: $addr) { … on ContractCall { entryPoint transaction { hash block { height } } } }` — confirm entry point matches your circuit and block height is non-null. midnight-js `txId` and indexer ledger `hash` are DIFFERENT strings; never string-match one against the other. After every `midnight:down`/`up`: redeploy AND restart Vite (LevelDB wiped, `ctxPromise` cached).

### React wallet-connect: never `setState` during render

Symptom: Chrome "Page Unresponsive" on Connect Lace. Cause: parent `setState` inside the wallet-bubble render body. Fix: bubble wallet state via `useEffect` only.

### EffectStream / dual-rail overlay (from x402midnight)

EffectStream is a **sync/overlay**, NOT a bridge. Sepolia Circle assets (USDC/EURC/cirBTC) stay on Sepolia; Midnight only stores the chunk anchor via `anchorChunk` on `StreamingChoreographyIP`.

- x402 challenge advertises `midnight-mUSDC` + Sepolia `exact` options on `eip155:11155111` simultaneously.
- Decimals per asset: USDC/EURC = 6, cirBTC = 8. Use `priceMicroUsdToTokenAtomic(asset, priceMicroUsd)`.
- Foundry `forge create` silently dry-runs without `--broadcast`; always confirm on the explorer.
- Etherscan V1 hosts are deprecated. Verify with V2: `--verifier-url https://api.etherscan.io/v2/api?chainid=11155111 --skip-is-verified-check`.
- Infura rejects gas > 2²⁴ (16 777 216). MetaMask falls back to 21M when `eth_estimateGas` fails (usually 0 balance / no allowance). Surface `balance ≥ required` and allowance BEFORE `writeContract`; map RPC gas-cap errors to "estimation failed; check balance".
- `/api/public/sepolia-fulfill` must return HTTP error when SCIP JSON missing or `VITE_NETWORK_ID !== "undeployed"` — NOT `midnightTxHash: "0xSIMULATED"` with `success: true`.
- Two networks, two wallets: Sepolia → MetaMask + Circle. Undeployed writes → server genesis wallet. Never conflate.

### Canonical file layout

```
src/lib/midnight-shared.ts             # seed, private-state id/store/password, deployer secret, domain sep
src/lib/midnight-providers.server.ts   # shared Undeployed providers bag
src/lib/<verb>.server.ts               # findDeployedContract + callTx.<verb>()
src/lib/<verb>.ssr-stub.ts             # inert stub, Cloudflare production build only
src/routes/api/public/<verb>.ts        # POST — Undeployed calls .server.ts; other nets defer to Lace
src/data/midnight-contract.undeployed.json
scripts/midnight-standalone.mjs        # writes standalone compose with full APP__INFRA__ env
scripts/deploy-midnight.mjs            # MidnightWalletProvider + CompiledContract.make
```

### New failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Unknown field "wallet" on type "Subscription"` | `wallet@5` against indexer 4.0.2 | Use `MidnightWalletProvider` + `wallet-sdk@1.2.0` + `testkit-js@4.1.1` |
| Indexer exits with `missing field 'secret' for key "INFRA"` | Compose only sets `APP__INFRA__NODE__URL` | Adopt full `midnight-local-dev/standalone.yml` env |
| Compact: `cannot pad "<long>:author:" to length 32` | Domain separator > 32 UTF-8 bytes | Shorten (`abodc:author:v1`, `ap2:buyer:v1`) |
| `disclose("(empty)")` compile error on `Opaque<"string">` | Literals are `Bytes<N>` | Drop constructor init |
| Deploy `MODULE_NOT_FOUND` on `contract/index.cjs` | Compact 0.31 emits ESM `index.js` | Resolve `.js` first |
| `NetworkId is not defined` at runtime | Type-only export at 4.1.1 | `setNetworkId("undeployed")`; use `wallet-sdk`'s `NetworkId.NetworkId.Undeployed` when a runtime enum is needed |
| `/api/public/<verb>` always returns `simulated: true` in dev | `midnightSsrStub()` runs on all SSR | Gate with `apply: "build"` |
| RpcError 117 / "cannot find private state" | Random `deployerSecret`/`privateStateId`/store between deploy and server | Move all to `src/lib/midnight-shared.ts`; both sides import the same constants |
| Indexer POST returns 405 | Sent GET | GraphQL requires POST |
| Chrome "Page Unresponsive" on wallet-connect | Parent `setState` during render | Bubble via `useEffect` only |
| UI "ANCHORED" with `midnightTxHash: "0xSIMULATED"` | Server silently returned fake hash | Fail loudly; verify via indexer `contractAction` |
| Etherscan verify: `Invalid API Key` on a valid key | Foundry hit V1 host | V2 with `--skip-is-verified-check` |
| Sepolia: `transaction gas limit too high (cap: 16777216, tx: 21000000)` | `eth_estimateGas` failed → MetaMask fell back to 21M → Infura cap | Fund/approve first; surface balance vs required before `writeContract` |
| `forge create` "succeeded" but nothing on-chain | Missing `--broadcast` | Add `--broadcast`; verify explorer receipt |

## 2026-07 update — flymidnight hard-won lessons (Fly.io hosted Undeployed)

From `github.com/arunnadarasa/flymidnight` — the canonical working example of a public
Fly-hosted Undeployed stack. Skip any one and hours evaporate.

1. **Readiness = `state.dust.state.progress.isStrictlyComplete()`.** WalletFacade 4.1.1
   shape. Do NOT check `state.progress?.isSynced`, `state.progress === true`, or an older
   `walletReady` boolean — those never flip on 4.1.1. Symptom: "warming up" toast stuck
   forever after DUST is fully synced. Debug once by logging the raw `state.dust.state.progress`
   object; it exposes `applyGap`, `sourceGap`, and `isStrictlyComplete()`.

2. **Browser → proof server MUST use the public HTTPS URL.** `https://choreo-proof.fly.dev`.
   The proof-server binary listens on IPv4 only, Fly 6PN is IPv6-only, and the browser is
   HTTPS — `choreo-proof.internal:6300` fails on all three counts. Do NOT wrap it with
   socat; the distroless image has no shell (`exec: 127`) and public IPv4 through Fly's
   edge is the supported path. Only server-to-server 6PN calls need `.internal` names
   (indexer → node, faucet → node); proof server is always public.

3. **`VITE_DEFAULT_CONTRACT` must OVERRIDE cached localStorage on load.** After a Fly
   redeploy the volume can rotate, and yesterday's contract address is dead — but the SPA
   cached it in `localStorage["midnight-contract-address"]`. On boot: prefer
   `import.meta.env.VITE_DEFAULT_CONTRACT` when set, otherwise fall back to localStorage.
   Symptom if you invert the priority: `Couldn't find template …` on every write after
   redeploy.

4. **Health probe order matters: node → indexer HTTP → indexer WS → proof HTTP.** If the
   node is stuck at #0 (see the Fly failure-mode table above), every other probe returns
   misleading errors and users chase phantom bugs. Fail fast on node before painting the
   rest of the preflight grid.

5. **Fund each Lace visitor from an in-app `Get tDUST` button.** The genesis seed `…0002`
   funds ONLY the deploy wallet; every Lace visitor on Undeployed starts with 0 tDUST and
   writes fail with a cryptic `Unexpected error submitting scoped transaction` after
   signing. Wire a Faucet button that POSTs `{ address: laceUnshieldedAddress }` to
   `${VITE_FAUCET_URL}/grant`. Poll `getDustBalance()` afterwards; disable the mint button
   until balance > 0.

6. **Retry the faucet with backoff for 90 s after redeploy.** `choreo-faucet` cold boot:
   `wallet.start()` needs 10–90 s to sync a non-zero balance. During that window `/grant`
   returns `503 warming up`. Show a "faucet warming up (~90 s)" toast, retry every 10 s,
   and don't set `min_machines_running=0` on the faucet unless you accept the delay.

7. **When you rebuild the node volume, refund the faucet.** Destroying `chain_data` wipes
   every previously-minted tDUST, including the faucet wallet. Follow the volume destroy
   with `bun scripts/fund-faucet.mjs` (uses genesis `…0002` seed → faucet `/health`
   address). Otherwise `/grant` returns 500 `Insufficient Funds` and the demo silently
   breaks.

## 2026-07 update — mobilemidnight hard-won lessons (Kuira Android on Undeployed)

Source: `arunnadarasa/mobilemidnight` (Tokenized Choreo Kits). First verified end-to-end Kuira dApp on Undeployed — passkey Sigil forge → `mn airdrop` funding → on-device ZK proving → 2 kits published (~25s warm prove).

### When to reach for Kuira

Mobile-first hackathon lanes (NFC tap-to-anchor, offline receipts, POS, wearables) where a browser + Lace extension is a non-starter. Passkey biometric identity replaces seed phrases. **Not a drop-in replacement** for the web/Lace path — different toolchain (Gradle/Kotlin/AVD), different local devnet (`mn localnet`, not Docker `midnight-node:0.22.5`), different funding path (`mn airdrop` CLI, no in-app browser faucet).

### Verified stack

| Piece | Version |
| --- | --- |
| Kuira SDK | `0.1.0-alpha05` |
| Compact | `0.31.1` |
| Local devnet | `mn localnet` (CLI — NOT `midnightntwrk/midnight-node:0.22.5` Docker image) |
| Proving | On-device |
| Reference AVD | API 35 `google_apis` arm64, 8GB host |

### Non-negotiables

- **Passkey `rpId` must be a real hosted domain** with a live `assetlinks.json` matching the app's package name AND the debug (or release) signing certificate SHA-256. `REPLACE_ME` / `.example` fails forge with `CreateCredentialNoCreateOptionException`. Reference binding that worked: domain `arunnadarasa.github.io`, DAL at `https://arunnadarasa.github.io/.well-known/assetlinks.json`, package `com.choreokits.mobile`.
- **After any `rpId` or assetlinks change: uninstall then reinstall.** `adb install -r` leaves Credential Manager in stale state and the Kuira docs are right — a fresh install is the only reliable reset.
- **Emulator prerequisites BEFORE debugging Credential Manager exceptions:** a signed-in Google account on the device, a screen lock set, and DAL live + package/SHA matched. Skip any of these and passkey create silently cancels no matter how correct your app code is.
- **Force the soft keyboard on:** `adb shell settings put secure show_ime_with_hard_keyboard 1` plus Gboard (`LatinIME`). Hardware/host keyboard input silently fails on Compose fields and Google WebView (`inputType=0`); `adb input text` paints characters that JS validation ignores.
- **NIGHT funding on Undeployed is a CLI airdrop, not an in-app faucet.**
  ```bash
  mn airdrop 10000 --wallet <mn_addr_undeployed1…> --network undeployed
  ```
  Then **Register dust in-app** (the Kuira flow, NOT `mn dust register`).
- **Never OCR / retype addresses from screenshots.** `l` vs `1` in bech32 breaks the checksum (`Invalid checksum… expected "2xmr28"`) and burns an airdrop. Copy from the app UI, or scrape via `adb exec-out uiautomator dump /dev/tty` and parse the `mn_addr_…` substring.
- **Kuira wallet UI uses `FLAG_SECURE` — `screencap` returns black frames.** Use `uiautomator dump` for automation instead of screenshots.

### Form-enablement pattern (real app bug we hit)

Symptom: Publish/Deploy button stayed disabled with all TextFields visibly filled, showing "Enter a kit title" despite a title being typed. Cause: enablement gate read a different piece of state than the TextField `value`. Fire-and-forget `viewModel.foo()` that only reads `.value` doesn't observe recompositions.

Fix pattern (used in `KitsCard.kt` / `KitsViewModel.kt`):

```kotlin
// Local rememberSaveable form state = source of truth
var title by rememberSaveable { mutableStateOf("") }
// Write-through to VM so business logic sees it
LaunchedEffect(title) { vm.setTitle(title) }
// Derive enabled from the SAME state the TextField writes
val blocked = publishBlockedReason(title, steps, priceDust)
Button(enabled = blocked == null, onClick = { vm.publish() }) { … }
```

### Verified happy path

```bash
# Host
mn localnet up
export JAVA_HOME="$(/usr/libexec/java_home 2>/dev/null || echo /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home)"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
./gradlew :app:installDebug

# Emulator (one-time)
# - Sign into a Google account (type password on the soft keyboard)
# - Set a screen lock
# - adb shell settings put secure show_ime_with_hard_keyboard 1

# In-app
# 1. Forge Sigil (passkey create)
# 2. Receive → copy mn_addr_undeployed1…
mn airdrop 10000 --wallet <addr> --network undeployed
# 3. Register dust in-app
# 4. Deploy catalog (on-device prove, ~30–120s cold)
# 5. Title / steps / priceDust → Publish kit
```

### Failure modes specific to Kuira / Android

| Symptom | Cause | Fix |
| --- | --- | --- |
| `CreateCredentialNoCreateOptionException` on forge | No signed-in Google account, or no screen lock, or Password Manager unavailable on this image | Sign into Google on the AVD, set a screen lock, prefer a Play Store system image over bare `google_apis` |
| DAL check reports `packageMatchesRpAssetlinks: false` | `assetlinks.json` not hosted, SHA-256 mismatch, or `rpId` still `REPLACE_ME`/`.example` | Publish DAL at `https://<rpId>/.well-known/assetlinks.json` with package + current debug signing SHA; set `PASSKEY_RP_ID` to that domain |
| Passkey create silently canceled after "correct" DAL fix | Credential Manager cached old rpId | Full uninstall then reinstall — `adb install -r` is not enough |
| `mn airdrop` returns `Invalid checksum… expected "…"` | Address retyped from screenshot; `l` vs `1` collision | Copy address from device UI or scrape with `uiautomator dump` |
| Publish button stays disabled with fields visibly filled | Enablement reads different state than TextField writes | Local `rememberSaveable` + write-through `LaunchedEffect`; derive `enabled` from the same state |
| `screencap` frames are black | Kuira wallet UI has `FLAG_SECURE` | Use `uiautomator dump /dev/tty` for automation |
| `adb input text` fills email/password but Google says "empty" | JS/WebView validation doesn't fire on injected input | Use on-screen Gboard; do not script Google auth via adb |
| `adb: command not found` on macOS | Unity's Android SDK `platform-tools` not on PATH | `export PATH="$ANDROID_HOME/platform-tools:$PATH"` (or Unity SDK path) |
| Gradle fails with cryptic JAVA_HOME error | Stale Corretto/JDK path | `export JAVA_HOME="$(/usr/libexec/java_home)"` — this build was verified on Homebrew OpenJDK 17 |
| Emulator OOM on 8GB host running headless | Kuira + AVD memory pressure | Run the emulator with GUI window; avoid `-no-window` on 8GB machines |

### Anti-patterns (Kuira-specific, add to the main list)

- Don't substitute the Docker `midnight-node:0.22.5` stack for `mn localnet` under Kuira — the SDK expects the `mn` CLI toolchain and its funding semantics.
- Don't automate Google account recovery / security codes via chat. Codes expire in ~60s and "Code 1 / Code 2" on the phone is a **number-match tap**, not the 10-digit Security code field.
- Don't ship `emulator-*.png`, `.cursor/debug-*.log`, or ad-hoc `scripts/emu-*.sh` helpers in the repo — clean before commit.
- Don't rely on host-keyboard input for Compose or WebView fields. Force the soft keyboard on from day one.

### Cross-references

- `mn` CLI install and Undeployed prerequisites: see `midnight-environment-setup`.
- The four-app Fly.io topology from the earlier flymidnight section is still valid as the indexer/proof backend if you'd rather host than run `mn localnet` on a laptop — point the Kuira SDK config at `https://choreo-indexer.fly.dev/api/v4/graphql` and `https://choreo-proof.fly.dev` the same way the web demos do.
- Reference build: `https://github.com/arunnadarasa/mobilemidnight` (Tokenized Choreo Kits).

---

## 2026-08 update — zealymidnight / MoveNft NFT rail on Undeployed

Source: `github.com/arunnadarasa/zealymidnight` (StreetRail Move Rights NFT). First verified
Compact NFT rail — **mint → list → buy settled in mUSDC** — on Local Undeployed, with
activity visible in the local ledger + indexer (`bun scripts/z-check.mjs` prints `E2E_OK`).
Read this BEFORE writing any NFT / marketplace Compact contract.

### NFT design rules (the headline lesson)

1. **Public ledger maps must be insert-only / append-only for v1.** The dust wallet's fee
   balancer panics when a circuit **updates an existing map key** — symptoms are
   `Wallet.Other: wasm.transaction_feesWithMargin` or `transaction_merge` *Unreachable* on the
   SECOND `callTx` against the same genesis wallet. It looks like cache invalidation or
   process isolation; it is not. Fix the ledger shape, not the plumbing.
   - `mint` and `listSale` insert NEW keys.
   - `buy` / `transfer` append to a `sales` map under a **fresh random id**.
   - Current owner lives in the server-side JSON mirror, not in an overwritten map cell.
2. **Do NOT start from an ERC-721-shaped Compact contract.** `_owners[tokenId] = newOwner`
   is exactly the overwrite that breaks. Defer lookup-heavy ownership checks to the server
   mirror (or a later shielded design).
3. **`list` is a reserved Compact keyword.** Name the circuit `listSale` and regenerate
   prover/verifier artefacts. Calling `callTx.list` against `listSale` keys is a silent footgun.
4. **Owner PK derivation must be identical everywhere.** Server used
   `sha256("movenft:owner:v1:" + label)` while an ad-hoc diagnostic script used raw
   `sha256(label)` → on-chain `not owner` while the local ledger looked correct. One helper,
   imported by server routes AND scripts.
5. **No cross-contract Compact call in v1.** Sequence `musdcFaucet` / `musdcTransfer`, then
   `MoveNft.buy`, inside ONE server handler; document it as demo-only atomicity (same genesis
   wallet). Do not promise atomic cross-contract settlement.
6. **Fresh wallet per call.** `withMoveNft(...)` mirroring `withMusdc(...)`, with `stop()`
   between contract families. Order that worked for the full rail:
   `mint → list → faucet (if needed) → pay → buy`. Opening mUSDC then MoveNft on the shared
   genesis LevelDB in one session leaves the next MoveNft submit broken.
7. **Undeployed writes stay server-append.** Lace cannot sign on Undeployed — reuse the
   MoveRegistry / mUSDC pattern (genesis wallet + `findDeployedContract` + `callTx`). Never
   half-wire Lace signing locally.

### Operational rules

- **Address resolution: deploy JSON first, env second.** Vite caches `VITE_*` across
  redeploys, so a stale `VITE_DEFAULT_CONTRACT` mints to a dead contract. Read
  `src/data/midnight-contract.undeployed.json`, reset per-contract local state on deploy, and
  keep the resolution in ONE unit-tested helper.
- **Redeploy checklist after ANY Compact change:**
  `midnight:compile` → `midnight:artefacts` → `rm -rf midnight-level-db .midnight` →
  `midnight:deploy` → restart `bun run dev` → run e2e. Never mix new verifier keys with an old
  LevelDB or old on-chain state. SSR keeps old addresses until the dev process restarts.
- **One exclusive "stack owner" process for e2e.** A single uniquely named script
  (`z-check.mjs`) does compile → artefacts → wipe → deploy → mint/list/buy, exits non-zero on
  any failure, and prints one `E2E_OK` line. Take a `mkdir`-based marker lock and refuse to
  start if another owner holds it. Never broadly `pkill` shared patterns (`bun -e`, `deploy-*`)
  while another job holds the stack — parallel agents wiping `midnight-level-db` mid-prove
  produce "exit 0" with truncated logs and deploy JSON timestamps that don't match the run.
- **Never pipe long proves through `awk`/`head`.** SIGPIPE kills the prove process and the e2e
  looks flaky. `tee` to `/tmp/<run>.log`, then `rg` the file.
- **Pinata is server-only.** `PINATA_JWT` / `PINATA_GATEWAY` — never `VITE_PINATA_*` (the
  Worker/Cloudflare secret-leak trap). Document in `.env.example` only, gate clip UI on server
  config, and restart dev after env changes.
- **macOS has no `flock`.** Use `mkdir`-based locks or unique process names.
- **Keep submission artefacts pushed as you go.** README, Compact sources, managed artefacts
  and the notes file should match every green e2e — not a final dump after the demo works.
- **Park the nice-to-haves** (OZ NonFungibleToken vendor, true atomic cross-contract buy,
  external-chain mint) until Undeployed mint/list/buy is boringly reliable.

### New failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `wasm.transaction_feesWithMargin` / `transaction_merge` Unreachable on the 2nd `callTx` | Circuit UPDATES an existing public map key; dust fee balancing panics | Redesign insert-only/append-only; fresh wallet per call (`withX`), `stop()` between contract families |
| `callTx.list` does nothing / key not found | `list` is a reserved Compact keyword; circuit is actually `listSale` | Rename circuit to `listSale`, regenerate artefacts, call `callTx.listSale` |
| On-chain `not owner` but local ledger looks right | Owner PK derived differently in server vs script | One shared helper: `sha256("movenft:owner:v1:" + label)` |
| `RpcError 117` | Stale private state — LevelDB vs chain (concurrent clients, killed mid-prove, wiped LevelDB without redeploy) | Wipe `midnight-level-db .midnight` AND redeploy, then restart Vite |
| `RpcError 104` | Dirty LevelDB after a failed faucet → mint handoff | Wipe + redeploy; sequence faucet and mint with `stop()` between |
| `RpcError 196` | Verifier key mismatch — recompiled artefacts without redeploying, or deployed against wrong keys | Recompile → refresh artefacts → redeploy in one pass |
| Mint targets a dead contract after redeploy | Stale `VITE_*` address cached by Vite | Resolve from `midnight-contract.undeployed.json` first; restart dev after deploy |
| e2e "flaky", logs truncated, exit 0 | Prove piped through `awk`/`head` (SIGPIPE), or a parallel agent `pkill`ed the run | `tee` to a log file; single stack-owner process with a `mkdir` lock |
| `SubmissionError` on the next `musdcTransfer` / `callTx` | A `MidnightWalletProvider` was cached across HTTP requests and still holds LevelDB open | Open → `callTx` → `stop()` in `finally`, one wallet per request (`withMusdc` / `withMoveNft` / `append-entry.server.ts`) |
| Partial single-contract redeploy still fails 117 / key mismatch | Redeployed only mUSDC (or only one contract) on top of dirty private state | Prefer a full `midnight:deploy`; only use a single-contract redeploy when state is known-clean |
| "Claim failed" in the UI but the transfer is on chain | The secondary registry `appendEntry` threw after the primary transfer succeeded | Soft-fail secondary appends; the token transfer is the receipt |
| `Database failed to open` | Parallel UI clicks or parallel agents writing the shared genesis LevelDB | UI busy flag on the write action; one exclusive stack owner in ops |
| Old branding / wrong UX on `:8080` | Dev server is serving a different working tree than the repo you edited | Confirm cwd and which tree Vite serves before calling it a UX bug |
| `bun <<'EOF'` prints help, runs nothing | Bun does not read a program from stdin that way | `bun scripts/foo.mjs` |
| Containers orphaned after moving the repo | Docker compose workdir vanished | Recreate from this repo's `docker-compose.yml` with an explicit `-p` project name |
| `/judge`-style panel stuck on "Pending" after a chain wipe | Pre-wipe tx hashes cached in `localStorage`; indexer lookup misses | Offer Refresh + Clear; these are not live stuck transactions |

### Anti-patterns (add to the main list)

- Don't half-wire Lace signing on Undeployed — the demo write path is the server genesis wallet.
- Don't model NFTs as ERC-721 in Compact with overwriting owner maps.
- Don't run parallel agents/shells against one Docker stack or LevelDB.
- Don't let the README claim features whose code isn't pushed yet.
- Don't prefix Pinata secrets with `VITE_`.
- Don't cache a wallet provider across HTTP requests — always `stop()` in `finally`.
- Don't hardcode a contract count in user-facing copy; derive it from the contract registry length.
- Don't keep re-clicking a failing UI action through an `RpcError 117` — run the recovery checklist.
- Don't leave the previous chain's branding in user-visible strings after migrating a demo to Midnight.

### Multi-contract topology (five contracts, one genesis wallet)

| Key | Compact source | Circuits | Witness domain |
| --- | --- | --- | --- |
| moveRegistry | `MoveRegistry.compact` | `appendEntry` | `abodc:author:v1` |
| moveNft | `MoveNft.compact` | `mint`, `listSale`, `buy`, `cancel`, `transfer` | `movenft:minter:v1` |
| mandateVault | `MandateVault.compact` | `anchorMandate` | `ap2:buyer:v1` |
| orderLedger | `OrderLedger.compact` | `recordOrder` | `ucp:merchant:v1` |
| midnightUsdc | `MidnightUSDC.compact` | `faucet`, `transfer` | `musdc:signer:v1` |

Keep one UI registry (`src/lib/contracts.ts` → `CONTRACTS`) and derive every user-facing count
from `CONTRACTS.length`. A hardcoded "four deployed contracts" heading goes stale the moment a
contract is added.

Ledger shapes that survive Undeployed:

```
MoveNft:      owners       // insert on mint only
              listed_price // insert on listSale / cancel under a NEW key
              sales        // append buy/transfer with a fresh random id

MidnightUSDC: credits / credit_to  // insert by nonce (transfer) or once by pk (faucet)
              faucet_claimed       // Set
              spent_nonces         // Set
```

**Insert-only applies to the token contract too.** Overwriting `balances[from]` /
`balances[to]` reproduces the exact `feesWithMargin` panic that the NFT redesign fixed — it
just surfaces later, on settle/claim instead of mint.

### Additional non-negotiables

1. **Never cache a `MidnightWalletProvider` across HTTP requests.** Open → `callTx` →
   `stop()` in `finally`, every request. A cached wallet holds LevelDB open and breaks the next
   contract family's call. No long-lived `ctxPromise`.
2. **One Midnight write at a time.** A UI busy flag on the write action, and exactly one
   process owning the Docker stack / LevelDB in ops. No parallel agents wiping state mid-prove.
3. **Soft-fail secondary appends.** When an action does a primary token write plus a secondary
   registry `appendEntry`, the append must never fail the whole action — the transfer is the
   receipt. Instrument transfer and append separately when debugging.
4. **Deploy JSON first, `VITE_*` second** — and after a redeploy restart Vite **and**
   hard-refresh the browser. HMR is not enough; SSR keeps the old address.
5. **Third-party keys stay server-only.** `PINATA_JWT` / `PINATA_GATEWAY`, never
   `VITE_PINATA_*`. Skip optional external verifiers (e.g. an ERC-1271 check) when the network
   is Undeployed or the secret is absent, instead of surfacing `missing_secret: <KEY>` in the UI.
6. **Humanize the recoverable RPC errors.** Map 117/104/196 to plain-language copy with the
   recovery action, rather than leaking `FiberFailure` stacks to the user.

### RpcError 117 recovery checklist (in order)

`SubmissionError` / `FiberFailure` usually **wrap** `RpcError 1010: Invalid Transaction: Custom
error: 117`. Don't retry the same click — run this:

```bash
# 1. stop the dev server
# 2. wipe local private state
rm -rf midnight-level-db .midnight
# 3. recreate node/indexer/proof if the chain may be dirty
docker compose -p <project> -f docker-compose.yml up -d
# 4. full deploy (not a single-contract redeploy)
bun run midnight:deploy
# 5. verify twice — expect TWO OK lines
bun scripts/debug-musdc-transfer.mjs
# 6. restart dev, hard-refresh the browser, then ONE action only
bun run dev
```

| Code | Action |
| --- | --- |
| 117 | Run the checklist above; do not keep retrying the same UI click |
| 104 | Wipe LevelDB + full deploy |
| 196 | Recompile artefacts + wipe + full deploy |
| UI "Pending" rows | Indexer miss or pre-wipe hash in `localStorage` — Refresh, then Clear if the chain was wiped |

Log long proves with `tee` + `rg` (see the prove-log rule above) while working through this —
piping through `awk`/`head` SIGPIPEs the prove and makes recovery look like flakiness.

## 2026-08 update — ipsmidnight lessons (Undeployed on Fly + UI-driven deploy)

From `github.com/arunnadarasa/ipsmidnight` — a clinical IPS console that provisions the whole
Undeployed stack on Fly and then deploys/anchors/verifies a Compact contract **from the UI**
instead of from a chat session. Everything below cost hours.

### Node RPC: one working shape only

- Publish the node's 9944 as a **pure `tls`** service through the Fly edge and point every
  consumer at `wss://<app>.fly.dev:9944`.
- Why nothing else works: `<app>.internal` is IPv6-only 6PN while the node binds IPv4 (and
  binding both is fragile); `<app>.flycast` needs a private IP allocation and still answered
  `000` even from inside the app; Fly's `http` handler terminates the WebSocket partway through
  a long proof submission, so writes fail after minutes of proving.
- Report reachability as measured facts, not assumptions: probe `127.0.0.1:9944/health` from the
  node machine and the edge URL from the indexer machine, and read public-IP / flycast presence
  back from Fly (`flycast: present|absent · public IP: …`).

### The indexer fails silently, so probe it explicitly

If the indexer cannot reach the node RPC it does not error — it serves an **empty chain** and the
UI reports block 0 forever, which looks like "nothing anchored yet". Always assert
`node reachable from indexer` as its own timeline step before believing any indexer answer.

### Runner-machine pattern (deploy from the UI, not from chat)

Contract compile → deploy → anchor → verify needs a persistent disk, the Compact toolchain, and
connections that stay open for minutes. The app runtime (edge/Worker) has none of that.

- Add a 4th **runner** machine to the same Fly app as node / indexer / proof server, with a volume
  holding the contract bundle, keys, and LevelDB private state.
- Drive it with the Machines `exec` API from a server function: `prepare` (pull the toolchain
  bundle), then fire-and-poll jobs. Never block a request on proving.
- Scripts must print **machine-readable result lines** (`RESULT {json}`) plus human log output, so
  one poll returns both a parsed result and a log tail the UI can render as a terminal.
- Ship the toolchain as a versioned tarball in storage and require an explicit "Prepare runner"
  step after you bump it — otherwise users silently run last week's contract code.
- Existence-probe before trusting stored state: Fly apps/machines get destroyed outside the app, so
  a "ready" row must be re-verified against Fly and downgraded rather than shown as green.

### SDK v4 provider gotchas

- `privateStoragePasswordProvider` has a **minimum length**; a short password throws during wallet
  construction with an unrelated-looking error.
- `httpClientProofProvider(url, zkConfigProvider)` must receive the *same*
  `NodeZkConfigProvider(CONTRACT_DIR)` instance you pass as `zkConfigProvider`. Omit it and the
  proof server answers `400 Bad Request` on `/check`.
- Genesis wallet must be fully synced before deploy; resync after any chain-data volume rebuild.

### Verification honesty (from a public code review of this repo)

- **Ledger membership is the only proof.** `commitments.member(commitment)` read from the deployed
  contract's public state is verification; a stored tx hash, a "confirmed" status column, or a
  green badge derived from your own database is not.
- **Persist the salt** alongside the anchor. A salted commitment whose salt was never stored can
  never be re-derived, which makes the anchor permanently unverifiable — and no reviewer will
  accept "trust the row".
- **Minimise credential claims.** Do not put patient name, title, or raw DOB in a credential that
  exists to prove a property; derive `over18` and ship that instead.
- **Label what you did not check.** Simulated credentials, unresolvable `did:prism` values, and
  unverified JWS signatures must render as *unverifiable / not checked*, never as pass. Reject
  simulated artefacts outright in signature-check paths.

### Key and state hygiene

- `.gitignore` must cover `.env`, the LevelDB private-state directory (`midnight-level-db/`), and
  `*.tgz` toolchain bundles. Untrack them if they already landed in a commit.
- Dev seeds, storage passwords, and contract addresses come from `process.env` with a documented
  fallback — never hardcoded literals in `scripts/*.mjs`.

### Graceful degradation

Any Fly/stack status server function must return an `unconfigured` result when `FLY_API_TOKEN` is
missing instead of throwing. A throw inside a loader or status query blanks the page and hides the
one instruction the user needs ("add the secret").

### New failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Indexer stuck at block 0, no errors | Indexer cannot reach node RPC | Publish 9944 as `tls` on the Fly edge; point the indexer at `wss://<app>.fly.dev:9944`; add an explicit reachability step. |
| Proof submission dies after minutes of proving | Fly `http` handler closed the WebSocket | Use a pure `tls` handler on 9944 — no `http`/`http_options`. |
| `000` from `<app>.flycast:9944` even inside the app | No private IP allocated / IPv6-only path to an IPv4 listener | Allocate the private IP for diagnostics, but route traffic over the public edge. |
| Proof server returns `400 Bad Request` on `/check` | `httpClientProofProvider` called without the `zkConfigProvider` | Pass the same `NodeZkConfigProvider` instance to both. |
| Wallet construction throws on start | `privateStoragePasswordProvider` value too short | Use a long password from env. |
| Anchor shows "confirmed" but cannot be proven to anyone | Salt not persisted; verification read from your own DB | Store the salt; verify with `commitments.member(commitment)` on-chain. |
| Contract "compiled but never deployed" | Runner never prepared, or running an old toolchain bundle | Bump the bundle version and require an explicit "Prepare runner" run. |
| Stack shows ready but the Fly app is gone | Stored state trusted without probing | Existence-probe app + machines and downgrade the row. |
| Page blanks with `FLY_API_TOKEN is not configured` | Status function throws | Return an `unconfigured` state. |

### Anti-patterns (add to the main list)

- Deriving a "verified" badge from your own database instead of the contract's public state.
- Putting raw PII in a credential whose only job is to prove a predicate.
- Committing `.env`, LevelDB private state, or toolchain tarballs.
- Running proving work inside the app runtime instead of on a persistent runner machine.
- Assuming `.internal` / `.flycast` reachability instead of probing it from the consuming machine.


---

## 2026-08 update — ipsmidnight hard-won lessons (runner toolchain, job observability, anchor UX)

Source: `github.com/arunnadarasa/ipsmidnight` (IPS Compass — International Patient Summary anchoring
on Undeployed via a Fly-hosted stack plus a persistent `runner` machine). These rules come from
getting deploy → anchor → verify green end-to-end from inside the app UI. Where they contradict
older sections, these win.

### 1. Pin the whole Compact/Midnight toolchain — including transitive alphas

- `@midnight-ntwrk/compact-js@2.5.3` depends on `@midnight-ntwrk/ledger-v9@^0.1.0-alpha.1`, which is
  **not published**. Every runner install dies with
  `npm error code ETARGET` / `notarget No matching version found for @midnight-ntwrk/ledger-v9@^0.1.0-alpha.1`.
  Pin `compact-js@2.5.1` — it resolves cleanly and has no `ledger-v9` edge.
- Runner bootstrap installs **exact pinned versions only**. Never `@latest`, never a caret on a
  Midnight package. A toolchain bump is a deliberate, tested change with a bundle-version bump.
- Before retrying an install, delete stale `package-lock.json` and `node_modules` from the
  half-finished attempt — otherwise the bad resolution is cached on the volume forever and every
  retry reproduces the same failure.
- Ship a **Clear toolchain** action so the user can reset a broken install without destroying the
  volume (and thereby the chain/private state).

### 2. A stalled install on a runner machine is an OOM kill, not a hang

Symptom: the install step stops mid-way with no error line, the UI retries forever, and the job
eventually exits `status=1`.

- Give the runner real resources: **4 vCPU / 4 GB RAM, 10 GB volume**. The Midnight SDK install is
  memory-hungry; 1 GB machines die silently.
- Install in **small sequential groups** with a persistent npm cache on the volume, not one giant
  `npm i`.
- Emit a **heartbeat every ~30 s** so the UI can distinguish "slow" from "dead".
- Surface Fly **machine events** (OOM flag, exit code) in the UI, not just the log tail — the log
  tail of an OOM-killed process is empty, which is exactly why it looks like a hang.

### 3. Detached jobs need step markers, not raw logs

- Runner scripts print explicit machine-readable markers: `STEP_<name>` on entry and
  `JOB_FAILED status=<n> during: <phase>` on exit. The UI maps them onto a **monotonic** step
  timeline (identical model to the stack deploy page) with per-step timers and a progress bar.
  Monotonic matters: never let a later log line move the timeline backwards.
- On failure, name the **exact command** that failed and include the npm debug-log tail.
- **Persist the failed job's state and log** (auto-expanded) after the run ends. A toast alone loses
  the only diagnostic the user could have pasted.
- Always ship a **copy-log** button. And never pipe long proving logs through `head`/`awk` —
  SIGPIPE kills the prove and the failure looks flaky.

### 4. Submitted ≠ verified — one status mapping, honest labels

- A transaction that landed on-chain is `anchored`, not `verified`. **Ledger membership is only
  confirmed by an explicit read-only check** against the contract's public state
  (`commitments.member(commitment)` via the indexer). Until that runs, label the row
  "anchored · not re-checked".
- Derive the status dot colour and the badge from **one shared tone helper**. Two independent
  mappings drift and a healthy `anchored` row renders amber/red, which reads as a failure.
- Once anchored, demote the write action to secondary (`Re-anchor`, outline) and promote the
  verification action to primary. The next useful click is verification, not another submit.

### 5. Mobile-first rows for long-running blockchain operations

- Single column on mobile: **metadata first**, then full-width equal-width action buttons in a
  2-up grid. Side-by-side buttons squeeze tx hashes and block numbers into hard-wrapped noise.
- Step timelines and log tails span the **full card width** — do not nest them inside the metadata
  column.
- `truncate` record/bundle titles in queue lists so a long clinical title cannot stretch the layout.

### New failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm error code ETARGET` / `notarget No matching version found for @midnight-ntwrk/ledger-v9@^0.1.0-alpha.1` | `compact-js@2.5.3` depends on an unpublished transitive alpha | Pin `compact-js@2.5.1`; pin every Midnight package exactly |
| Toolchain install fails identically on every retry | Stale `package-lock.json` / `node_modules` from the half-finished attempt cached on the volume | Clear them in bootstrap; expose a "Clear toolchain" action that keeps the volume |
| Install stalls mid-step with no error, then `status=1` | Runner machine OOM-killed (empty log tail) | 4 vCPU / 4 GB, sequential install groups, npm cache on volume, 30 s heartbeats, surface Fly machine events + exit code |
| Detached job "failed" with nothing to debug | Error only shown as a toast | Persist failed job state + log tail, auto-expand, add copy-log |
| Step timeline jumps backwards during a job | UI recomputes step from the newest matching log line | Make step derivation monotonic — only advance |
| Anchored row shows an amber/red dot and looks broken | Dot and badge computed from separate status maps | One shared tone helper feeding both |
| UI claims "verified" right after submitting | Verification inferred from your own DB write | Only `verified` after a read-only ledger membership check; otherwise "not re-checked" |

### Anti-patterns (add to the main list)

- Installing Midnight packages on the runner with `@latest` or caret ranges — one unpublished
  transitive alpha breaks every deploy.
- Retrying a failed toolchain install without clearing the stale lockfile / `node_modules`.
- Running the SDK install as one giant `npm i` on a small machine and reading the resulting silence
  as a hang.
- Showing a detached job's only error in a toast.
- Deriving status colour in two places.
- Calling a submitted transaction "verified".

---

## 2026-09 update — Midnight-native DID and VC ecosystem state

Sources: https://midnightntwrk.github.io/midnight-did/ and
https://github.com/midnightntwrk/midnight-verifiable-credentials. Read this before
promising a user a "Midnight-native identity + credentials" stack.

1. **`did:midnight` exists and is real code.** `@midnight-ntwrk/midnight-did-contract`
   (Compact contract holding DID state on-ledger: verification methods, relations,
   services, aliases, metadata, plus lifecycle circuits) and
   `@midnight-ntwrk/midnight-did` (mapping layer from ledger state to W3C DID Core
   documents), both published at `0.5.0` after a long `0.4.0-snapshot.*` / `0.5.0-rc*`
   stream. Resolution is an **indexer read of contract state** — the same shape as any
   other public-ledger read. Resolver service, DID manager UI and key custody live in a
   separate `midnight-did-resolver` repo with nothing found published to npm; expect to
   self-host or write your own reader.
2. **There is NO usable Midnight-native VC stack yet.**
   `midnight-verifiable-credentials` was created Dec 2025, publishes no npm packages,
   and its open issues are dominated by dev-tooling/SDLC work rather than credential
   features. Credential formats (JWT / SD-JWT / BBS+), selective disclosure and
   revocation are undocumented. Signature verification stays your own problem (JOSE) or
   an external agent's (Identus). Do not scaffold imports against guessed package names.
3. **Adopting DIDs does not adopt VCs.** Shipping `did:midnight` without credential
   verification produces a DID that resolves and a credential nobody can check — that is
   *worse* than the status quo, because the UI looks complete. Move both layers or
   neither, and keep the verify surface labelled "signature not checked" until JWS
   verification actually runs.
4. **Pin exact `0.x` versions and treat identifier-format changes as breaking.** The
   `did:midnight` syntax — including how it embeds the deploying contract's address —
   was still an open upstream design discussion. This is the same trap as
   `compact-js@2.5.3` → unpublished `ledger-v9` alpha: a caret on a pre-1.0 package
   whose format is unsettled.
5. **A DID contract is an addition, not a replacement.** It does not subsume your
   application's anchoring/commitment contract: it is a second contract, a second
   proving flow, and a second thing that can be down. Keep the two lifecycles separate.
6. **Don't assume networks beyond Undeployed.** No published network support matrix was
   found; assume dev/Undeployed only until proven otherwise.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `npm error 404` on a guessed `@midnight-ntwrk/*` VC package | `midnight-verifiable-credentials` publishes nothing | Don't scaffold against it; use Identus or hand-rolled JOSE for VC issue/verify |
| DID resolves but credential signature is unchecked, UI reads "verified" | DID migration shipped without a VC verification path | Label honestly; ship verification before the "verified" affordance |
| `did:midnight` identifiers break after a dependency bump | Identifier syntax still unsettled upstream, caret range in place | Exact-pin `midnight-did` / `midnight-did-contract`; treat bumps as breaking |
| An in-container/in-memory DID ledger presented as externally resolvable | Self-hosted PRISM-style node with no public ledger backing | Either state plainly that DIDs are stack-local, or move DID state on-ledger |

### Anti-patterns (append)

- Promising "Midnight-native verifiable credentials" today — the DID half ships, the VC half does not.
- Migrating the DID method while leaving signature verification unimplemented.
- Caret ranges on `midnight-did*` while its identifier spec is under discussion.
