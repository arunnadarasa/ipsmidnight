# IPS Console — Identus + Midnight (Undeployed) on Fly.io

A clinical-grade console for the International Patient Summary (IPS): build or import a FHIR IPS bundle, issue it as a verifiable credential through a Hyperledger Identus agent, and anchor a privacy-preserving commitment on the Midnight Undeployed network — with the Midnight node/indexer/proof-server stack provisioned on Fly.io from inside the app.

Current project state: fresh TanStack Start template (placeholder home page, no backend, no integrations yet). Everything below is new work.

## What the app will do

1. **Sign in** (Lovable Cloud email auth). All records are scoped to the signed-in user.
2. **IPS workspace** — compose a summary with a guided form covering the IPS required sections (patient, problems, allergies/intolerances, medications) plus optional ones (immunizations, results, devices, procedures), or paste/upload an existing FHIR IPS Bundle. Ships with sample bundles (HL7 IPS + an NHS-SCR-style example). A validator panel reports missing required sections and profile issues, and a read-only viewer renders the bundle section by section.
3. **Identus console** — register/connect an Identus Cloud Agent (simulated mode by default, or a real agent URL + API key), manage DIDs, and issue an IPS credential (connectionless JWT offer) whose claims carry the summary digest, patient reference and a `dob` claim so age proofs stay possible.
4. **Midnight console** — a Fly.io deploy panel that provisions the Undeployed stack (node, indexer, proof server, faucet) using your Fly organisation token, shows a health preflight grid (node → indexer HTTP → indexer WS → proof HTTP), a `Get tDUST` faucet button, and an anchor action that records the IPS commitment on-chain via a server route using the genesis wallet.
5. **Verify** — paste a credential or pick one, check the Identus signature, recompute the digest, and confirm the on-chain anchor via the indexer. Shows what the verifier learns (a commitment) versus what stays private (the clinical content).
6. **Activity log** — every issue / anchor / verify event, timestamped and per-user.

## Pages

- `/` — landing: what IPS is, the privacy model, live stack status, sign-in CTA.
- `/auth` — sign in / sign up.
- `/app` — dashboard: agent mode, Midnight stack health, recent activity.
- `/app/ips` — bundle builder, upload/paste, samples, validation, viewer.
- `/app/identus` — agents, DIDs, credential issuance.
- `/app/midnight` — Fly deploy panel, machine diagnostics, faucet, anchors.
- `/app/verify` — verification flow.
- `/app/activity` — audit trail.
- `/docs` — how to run the local Compact toolchain and what the Undeployed limits are.

## Build order

1. Enable Lovable Cloud; migration for `profiles`, `user_roles` (+ `has_role`), `agent_connections`, `ips_bundles`, `credential_records`, `midnight_anchors`, `activity_log` — each with grants, RLS scoped to `auth.uid()`, and seeded sample IPS bundles inserted as literal rows.
2. Design system + shell: clinical dark/light palette, distinctive type pairing, `AppShell` + `MarketingHeader`, mode badge, truncated-mono component for DIDs/hashes.
3. IPS domain layer: FHIR IPS types, section registry, validator, canonical-JSON digest helper, sample bundles.
4. IPS builder / upload / viewer pages.
5. Identus layer: `*.server.ts` clients (health, DIDs, connectionless issuance) + `identus.functions.ts` wrappers, simulated mode fallback, console pages.
6. Midnight layer: Compact contract (`IpsAnchor.compact`, insert-only append), local deploy script, Fly provisioning server functions, health preflight, faucet, anchor route.
7. Verify page + activity log.
8. SEO heads per route, security scan, publish.

## Technical notes

- **Server boundaries:** raw logic in `*.server.ts`, exposed via `createServerFn` in `*.functions.ts`; routes import only `*.functions.ts` and types. Fly/Midnight secrets read inside handlers only.
- **Midnight stack pinning (per the Midnight skill):** `MidnightWalletProvider` + `wallet-sdk@1.2.0` + `testkit-js@4.1.1` + `midnight-js-*@4.1.1` against `indexer-standalone:4.0.2`. No `wallet@5`. `setNetworkId("undeployed")`.
- **Undeployed writes are server-append.** Lace cannot sign on Undeployed, so anchoring goes through `/api/public/ips-anchor` using the genesis seed (`…0002`), with shared constants (`PRIVATE_STATE_ID`, store name, password, deterministic deployer secret) in `src/lib/midnight-shared.ts` so deploy and append agree. If the contract JSON is missing the route fails loudly — never a fake `0xSIMULATED` "anchored" state.
- **Ledger shape is insert-only.** Anchors go into an append map under a fresh random id; no key is ever overwritten (overwrites crash the dust fee balancer).
- **Fly.io:** browser talks to the proof server over its public HTTPS URL; server-to-server calls use `.internal` 6PN names. Health grid probes node first. Faucet retries with backoff for ~90s on cold boot. Contract address resolves from deploy JSON first, env second.
- **Compact compile + deploy run here in the sandbox.** I install the Compact toolchain (`compact-installer.sh` + `compact update`), run `compact compile contracts/IpsAnchor.compact contracts/managed/ips-anchor`, copy `keys/` and `zkir/` into `public/`, then run `bun scripts/deploy-midnight.mjs` against your Fly-hosted node/indexer/proof-server over public HTTPS — no Docker or local machine needed. The deploy writes `src/data/midnight-contract.undeployed.json`, which the app reads (deploy JSON first, env second). `/docs` documents the same commands for reproducing it yourself.
- **No SSR for Midnight JS:** all `@midnight-ntwrk/*` browser usage sits behind a client-only boundary; `optimizeDeps.exclude` list added from day one.
- **PHI handling:** clinical content stays in your Cloud database under RLS; only a digest/commitment ever reaches the chain. Clearly labelled demo software, not for real patient data.

## What I'll need from you

- Your **Fly.io organisation token** — that's it. I'll open a secure form for `FLY_API_TOKEN` when we reach step 6, then provision the stack, compile the contract and deploy it from this sandbox.
