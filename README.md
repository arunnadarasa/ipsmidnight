# IPS Compass

A clinical console for the **International Patient Summary (IPS)** that joins three things usually kept apart:

1. **FHIR IPS authoring** — build or upload an IPS document bundle, validate its structure against the IPS implementation guide, and derive a stable SHA-256 digest of it.
2. **Verifiable credentials** — issue a credential over that digest with **Hyperledger Identus** (simulated locally, or against a real Identus Cloud Agent).
3. **Privacy-preserving anchoring** — commit the digest to a **Midnight** ledger (Undeployed network) through a Compact smart contract, so a verifier can confirm a summary existed and was unchanged without ever seeing patient data.

All Docker infrastructure for 2 and 3 is provisioned **from inside the app** onto **Fly.io** Machines — no local Docker, no `docker compose`, no CI.

**Live app**: https://ipsmidnight.lovable.app
**Source**: https://github.com/arunnadarasa/ipsmidnight

---

## Contents

- [Architecture](#architecture)
- [Feature walkthrough](#feature-walkthrough)
- [Data model and security](#data-model-and-security)
- [The Compact contract](#the-compact-contract)
- [Engineering practices we followed](#engineering-practices-we-followed)
- [Issues encountered and how they were solved](#issues-encountered-and-how-they-were-solved)
- [Known limitations](#known-limitations)
- [What we would do differently next time](#what-we-would-do-differently-next-time)
- [Local development and setup](#local-development-and-setup)
- [Reference links](#reference-links)

---

## Architecture

The app is a TanStack Start (React 19 + Vite) application. Everything privileged — the Fly API token, the Identus admin key, all database writes that touch clinical data — lives in server functions. The browser never holds an infrastructure credential.

```text
                         ┌───────────────────────────────────────┐
                         │  Browser (React 19 / TanStack Router) │
                         │  IPS builder · Identus · Midnight     │
                         │  Deploy timeline · Verify · Activity   │
                         └──────────────────┬────────────────────┘
                                            │ typed RPC (createServerFn)
                         ┌──────────────────▼────────────────────┐
                         │  Server runtime (edge worker)          │
                         │  *.functions.ts  → thin RPC wrappers   │
                         │  *.server.ts     → Fly / agent clients │
                         └────┬──────────────────────────┬────────┘
                              │                          │
              ┌───────────────▼──────────┐   ┌───────────▼─────────────────┐
              │  Lovable Cloud (Postgres)│   │  Fly.io Machines API        │
              │  auth · RLS · summaries  │   │  provision / exec / destroy │
              │  credentials · anchors   │   └───┬────────────────────┬────┘
              └──────────────────────────┘       │                    │
                                      ┌───────────▼─────────┐  ┌──────────▼──────────────┐
                                      │ Identus stack (Fly) │  │ Midnight stack (Fly)    │
                                      │ postgres:16-alpine  │  │ midnight-node 1.0.0     │
                                      │ prism-node 2.5.0    │  │ indexer-standalone 4.3.3│
                                      │ cloud-agent 1.40.0  │  │ proof-server 8.1.0      │
                                      └─────────────────────┘  │ runner (node:22-slim)   │
                                                               └─────────────────────────┘
```

Machines inside a Fly app talk to each other over Fly's private **6PN** network (`<group>.process.<app>.internal`), which is **IPv6-only** — a detail that caused most of the early boot failures (see [Issues](#issues-encountered-and-how-they-were-solved)).

Key modules:

| Path | Role |
| --- | --- |
| `src/lib/ips/{types,builder,validate,digest}.ts` | IPS section specs, form-state → FHIR bundle builder, structural validator, canonical SHA-256 digest |
| `src/lib/midnight/shared.ts` | Pinned Midnight images, runner SDK pins, indexer env contract, 6PN + public URL helpers, `ips:anchor:v1` domain separator |
| `src/lib/midnight/fly.server.ts` | Fly Machines client for the node / indexer / proof-server / runner stack |
| `src/lib/midnight/runner.server.ts` | The runner machine: launches, polls and reads results for deploy / anchor / verify jobs over Fly `exec` |
| `src/lib/runner-steps.ts` | Maps a runner job (kind + log tail + result) onto the same step-timeline model as the Deploy page |
| `src/lib/identus/fly-shared.ts` | Identus images, four-database layout, Postgres init SQL, JVM IPv6 flags, agent boot-log wrapper |
| `src/lib/identus/{fly,cloud-agent}.server.ts` | Provisioning, health probes, log tailing, DID publication, connectionless issuance |
| `src/lib/stack.functions.ts` | Unified `provision / check / repair / repairIdentusOnly / destroy / list` server functions |
| `src/lib/stack-steps.ts` | Derives an ordered, human-readable step list from raw machine states + health probes |
| `src/components/deploy/StackTimeline.tsx` | Progressive deployment timeline UI with live boot timers and error extraction |
| `src/components/deploy/ContractLifecycle.tsx` | In-app contract lifecycle panel: prepare runner, deploy contract, clear toolchain, per-row anchor/verify with step timeline + copy-log |
| `contracts/IpsAnchorRegistry.compact` | The anchoring contract; compiled artifacts under `contracts/managed`, ZK keys under `public/keys` and `public/zkir` |
| `scripts/deploy-midnight.mjs` | Deploys the compiled contract against a provisioned Fly stack |
| `scripts/anchor-midnight.mjs` | Submits a commitment to the deployed contract and writes the tx reference |
| `scripts/verify-midnight.mjs` | Read-only ledger membership check — queries the indexer and calls the contract's `ledger()` view |

---

## Feature walkthrough

### Dashboard (`/app`)
Counts of summaries, issued credentials and anchors, the current stack status, and shortcuts into the Deploy console. Everything is scoped to the signed-in user.

### IPS workspace (`/app/ips`)
Two ways in, one output:

- **Guided builder** — a form per IPS section (Patient, Allergies and Intolerances, Medication Summary, Problem List, Immunizations, Results, and the rest defined in `IPS_SECTIONS`). The builder emits a conformant `Bundle` of type `document` with a `Composition` whose sections carry the correct **LOINC** codes and `Organization`/`Practitioner` authorship.
- **Upload / paste** — drop an existing FHIR JSON bundle, or start from a bundled **sample bundle** so the flow can be demonstrated without real data.

Both paths run through:

- **Structural validation** — bundle type, presence and position of the `Composition`, required sections and their LOINC codes, resolvable internal references, and required patient identifiers. Findings are reported as errors vs warnings so a partially complete draft is still usable.
- **Digest** — the bundle is serialised deterministically (stable key ordering, normalised whitespace) and hashed with SHA-256. This digest, never the bundle, is what leaves the database.

Saved summaries live in the **library** with their digest and validation state.

### Identus console (`/app/identus`)
Two modes, selectable in the UI:

- **Simulated** — a local issuer that mints DIDs and credential records shaped like the agent's own responses. Good for demos and for working on the UI without waiting on a JVM boot.
- **Fly.io Cloud Agent** — a real Identus Cloud Agent 1.40.0 stack (Postgres + PRISM node + agent). The console publishes a DID and performs **connectionless credential issuance** over the agent's REST API, with the IPS digest as a claim.

Issued credentials are recorded against the summary they attest.

### Midnight console (`/app/midnight`)
Stack status (node / indexer / proof server / runner), the resolved indexer GraphQL and proof-server endpoints, and the anchoring action. Each saved summary can be queued as an anchor; each anchor row carries its commitment and (once submitted) its transaction reference, and exposes two actions:

- **Submit / Re-anchor** — queues the commitment on the runner, which calls `anchorSummary` on the deployed contract and writes back the tx hash and block height. A submitted anchor reads as **anchored · not re-checked** until you explicitly verify it — the presence of a transaction hash is *not* treated as verification.
- **Check ledger** — runs `scripts/verify-midnight.mjs` on the runner: a read-only query of the indexer for the contract's public state, then a call to the generated `ledger()` view's `commitments.member(commitment)`. The toast reports whether the commitment is in the on-chain Set.

Both actions render a per-row step timeline (wallet sync → proving → confirmed / reading ledger → answer) and a collapsible runner log with a copy button.

### Deploy console (`/app/deploy`)
The unified provisioning surface. One action provisions **both** stacks; `checkFullStack` polls them; `repairFullStack` re-applies machine metadata and config; `repairIdentusOnly` ("Fix agent DB") recreates just the Identus Postgres so its init SQL reruns without disturbing a healthy Midnight stack; `destroyFullStack` tears everything down.

Progress is rendered as a **step timeline** rather than a spinner: each step reports pending / booting / healthy / failed, with a live elapsed timer, restart counts, OOM detection, contextual hints (e.g. "database migrations typically take 60–90s"), and — critically — the extracted **cause line** from the failing container's logs with a copy button.

The page also hosts the **Anchor contract** panel — the full Compact lifecycle, driven from the UI instead of a terminal:

- **Prepare runner** — boots the dedicated `node:22-bookworm-slim` machine inside the Midnight Fly app and installs the Midnight SDK onto its volume in four sequential groups. The install runs as a detached job (Fly caps `exec` at ~30s while proving takes minutes), polled until the `.ready` marker is written.
- **Deploy contract** — runs `scripts/deploy-midnight.mjs` on the runner to prove and submit the contract's initial state; the address and deploy tx are persisted in `midnight_contracts`.
- **Clear toolchain** — wipes `node_modules`, the npm cache and the `.ready` marker on the runner's volume without touching the volume itself, the LevelDB private state, or the deployed contract — the escape hatch for a half-finished install.

The panel renders the same progressive step timeline as the stack itself, keeps a failed job's log and error visible after polling stops, and has a copy-log button. Contract deploy / anchor / verify all run on the runner, not from a local terminal.

### Verify (`/app/verify`)
A check on a bundle a verifier has been handed. Each pass reports independently, so a partial failure tells you *which* link broke — and passes that the code cannot actually perform are reported as **not checked** rather than green:

1. Structural IPS validation.
2. Recompute the digest from the canonical bundle JSON and compare it to the credential's `summaryDigest` claim.
3. Confirm a *real* credential exists (a pending hosted offer with no JWT is not a credential).
4. **Issuer signature: not verified.** The console decodes the JWT payload; it performs no JWS verification, no DID resolution and no status-list check. Simulated credentials use `alg: none` with a stub hash and are reported as proving nothing.
5. Recompute the commitment from `digest + stored salt` and compare it to the stored commitment, then require the anchor to be on-ledger. Anchors written before salt persistence cannot be recomputed and fail closed.

True on-chain verification is a separate, per-row action on the Midnight page (**Check ledger**): a read-only runner job (`scripts/verify-midnight.mjs`) loads the contract's public state from the indexer and asks the generated `ledger()` view whether `commitments.member(commitment)` holds. The existence of a transaction hash is **not** treated as verification anywhere.



### Activity log (`/app/activity`)
An append-only audit trail of provisioning, issuance and anchoring events per user.

---

## Data model and security

Tables (Lovable Cloud / Postgres):

| Table | Contents |
| --- | --- |
| `profiles` | One row per auth user, created by trigger on sign-up |
| `user_roles` | Roles in a **separate** table (never on `profiles`), read through a `security definer` `has_role()` function |
| `agent_connections` | Identus agent endpoints and mode per user |
| `fly_deployments` | Provisioned Fly apps, keyed by kind (`midnight` / `identus`), with machine IDs and resolved URLs |
| `ips_bundles` | Saved summaries, their digest and validation status |
| `sample_bundles` | Shipped demo bundles, readable by all signed-in users |
| `credential_records` | Issued credentials linked to a bundle |
| `midnight_anchors` | Commitments, the **salt** the commitment was derived from, transaction references, contract address |
| `midnight_contracts` | Deployed contract address + deploy tx per user/app-prefix, so anchors survive a destroyed runner volume |
| `activity_log` | Audit events |

Security posture:

- **RLS on every table**, with per-user `auth.uid()` policies, plus explicit `GRANT`s for `authenticated` and `service_role` in the same migration as each `CREATE TABLE` (PostgREST grants nothing by default — RLS alone leaves the table unreachable).
- **Privilege escalation avoided by design**: roles are a separate table read via a security-definer function, never a boolean on a user-owned row. The `user_roles` table carries explicit `WITH CHECK (false)` deny policies for INSERT/UPDATE/DELETE against `authenticated` and `anon`, and all client-side write privileges are revoked — roles are assigned only by the signup trigger / service role.
- **SECURITY DEFINER functions are not API-callable.** `handle_new_user`, `has_role`, `touch_updated_at` are revoked from `PUBLIC`, `anon` and `authenticated`; only `service_role` may execute `has_role`, so a browser session cannot invoke them directly.
- **Storage is owner-scoped.** The private `midnight-artifacts` bucket enforces RLS by top-level folder: a file must live under a folder named `auth.uid()::text` for any SELECT/INSERT/UPDATE/DELETE, so a user can only touch their own contract bundle.
- **Data minimisation in credentials.** A credential carries the `summaryDigest`, the credential type, and — only when the summary has a birth date — a derived `over18` boolean. No patient name, no summary title, no raw date of birth, no clinical content.
- **Commitments are recomputable.** `commitment = H("ips:anchor:v1" ‖ digest ‖ salt)` and the salt is persisted with the anchor. Without the salt an anchor is unverifiable, so anchors missing one fail closed instead of reading as confirmed.
- **Secrets never reach the browser.** The Fly API token and the Identus admin key are read inside `.handler()` bodies of server functions. `*.server.ts` modules are excluded from client bundles by filename; the client only ever imports `*.functions.ts`.
- **Key material is not committed.** The Midnight LevelDB private-state store, `.env` and packaged bundles are git-ignored. The dev-network genesis seed, deployer secret and private-state password in `scripts/*.mjs` are the well-known Undeployed test values and are overridable via `MIDNIGHT_GENESIS_SEED`, `MIDNIGHT_DEPLOYER_SECRET_HEX` and `MIDNIGHT_PRIVATE_STORAGE_PASSWORD`. They must not be reused on a real network.
- **Google sign-in** is enabled alongside email; anonymous sign-ups are off.

---

## The Compact contract

`contracts/IpsAnchorRegistry.compact` is an **append-only commitment registry**. It exposes a circuit that takes a commitment derived from `(IPS_DOMAIN, digest)` and inserts it into a ledger set, refusing duplicates. Reads are membership checks — the contract stores no patient data, no identifiers, and no metadata that could be correlated back to a person.

The toolchain flow used here is deliberately unusual and worth calling out: the **Compact compiler runs in the Lovable Linux sandbox**, not on a developer laptop.

```sh
# in the sandbox
compact compile contracts/IpsAnchorRegistry.compact contracts/managed
# compiled ZK keys / IR are published under public/keys and public/zkir
node scripts/deploy-midnight.mjs   # deploys against the provisioned Fly stack
```

Deployment targets the Fly-hosted Undeployed stack over public HTTPS (indexer GraphQL + proof server), with the node's RPC reached over 6PN from a one-shot machine in the same Fly app.

---

## Engineering practices we followed

- **Hard server/client boundary.** `*.server.ts` for anything that touches a credential; `*.functions.ts` as thin `createServerFn` wrappers with nothing at module scope but imports, types and the exported declarations. Server-function splitting deletes runtime siblings, so helpers live in imported modules.
- **No browser-only library in the SSR graph.** Midnight's JS SDK is loaded lazily on the client, never statically imported from a route that server-renders.
- **Every image tag pinned.** `proof-server:latest` shipped incompatible proving keys mid-demo; tags are now fixed and the reason is a comment in `shared.ts`.
- **Env contracts documented next to the spec.** Indexer 4.x refuses to boot unless every `APP__INFRA__*` key is present, so the full set lives in one exported constant instead of being scattered across the provisioner.
- **Idempotent, granular recovery.** Provision, check, repair, repair-Identus-only and destroy are separate operations; repairing a broken agent must not restart a healthy ledger.
- **Errors are surfaced, not swallowed.** Every non-OK provider response logs and returns the upstream status *and* body. A generic 500 during infrastructure bring-up costs hours.
- **Design tokens, not hardcoded colours.** A "Midnight dark" clinical theme (Sora / Manrope) defined in `src/styles.css`; components use semantic tokens.
- **Mobile-first review.** Headings and panel actions stack on small screens, tab strips scroll horizontally, long hashes and IDs wrap instead of overflowing, touch targets are enlarged, and the app header is sticky.

---

## Issues encountered and how they were solved

This section is the honest part. Bringing up Midnight and Identus on Fly Machines was the bulk of the work.

| Symptom | Root cause | Fix |
| --- | --- | --- |
| Identus agent: `UnknownHostException` resolving `identus-postgres.process.<app>.internal` | Fly's `<group>.process.<app>.internal` DNS names only resolve when a machine declares its process group | Set `metadata: { fly_process_group: "<name>" }` on **every** machine; added `repairFullStack` to back-fill metadata on already-created stacks |
| Midnight node crash-looping, exit code 1, seconds after start | The `0.22.x` node image rejected the dev-network CLI flags we passed | Moved to `midnight-node:1.0.0` driven by `CFG_PRESET=dev` (auto-authoring) instead of hand-rolled flags |
| Node and indexer unreachable from siblings despite running | Services bound to IPv4 loopback; Fly's private network is IPv6-only | Bind the node RPC to `[::]:9944` and set `APP__INFRA__API__ADDRESS: "::"` on the indexer; JVM gets `-Djava.net.preferIPv6Addresses=true -Djava.net.preferIPv4Stack=false` |
| Chain state lost on every machine replacement | Node wrote to the container filesystem | Attached a 10 GB Fly volume `midnight_chain` mounted at `/node/chain` |
| Cloud agent exited 1, but Fly's log stream only showed healthy `prism-node` output | Machines API has no per-container log endpoint; the agent's own stderr was drowned out | Wrapped the agent entrypoint to tee stdout/stderr into `/tmp/agent-boot.log` (`tail -F` keeps the live stream, `exit $c` preserves the real exit code) and read that file back over `machines/:id/exec` |
| Log tail intermittently returned `failed_precondition: machine not running` | A crash-looping machine is down for part of each cycle, so `exec` has no target | Kept a short post-crash window before replacement and added file-based fallbacks — but the real fix is stopping the crash, not reading it faster |
| **The actual agent failure**: `zio.FiberFailure: ERROR: role "pollux-application-user" does not exist` | Identus 1.40.0's first Flyway statement is `ALTER DEFAULT PRIVILEGES … TO "<db>-application-user"`. That login role is created by upstream's compose init scripts, which we had not replicated | Rewrote `POSTGRES_INIT_SQL` to create one `<db>-application-user` role per database (`pollux`, `connect`, `agent`, `node`) and apply `ALTER DEFAULT PRIVILEGES` + `GRANT USAGE, CREATE ON SCHEMA public` **inside each database** via `\connect` hops |
| The role fix didn't take on an existing stack | Postgres init scripts run only against an **empty** data directory | `repairIdentusOnly` destroys and recreates just the Identus Postgres machine so init reruns — surfaced as a **Fix agent DB** button |
| Health probes spun forever while a machine was already dead | Step state was derived from probe results alone | `stack-steps.ts` now derives state from machine state first and short-circuits downstream probes once a boot failure is detected; `exitSummary` reports restart counts and OOM kills |
| Two speculative "fixes" that were wrong: adding `DEFAULT_WALLET_SEED` (derived from the admin key) and a duplicate `POSTGRES_*` env group | Guesses, not findings. Research into the agent's `application.conf` showed the wallet seed is auto-generated when absent, and the Postgres secret-storage backend reuses the existing `AGENT_DB_*` variables — there are no bare `POSTGRES_*` bindings | Both reverted. Recorded here because they cost a debugging cycle and made the real error harder to see |

---

## Known limitations

- **Undeployed / dev network only.** The Midnight stack runs the local dev preset. There is no testnet or mainnet wiring, no faucet-funded production wallet, and no key management story beyond what the dev preset provides.
- **No signature verification anywhere.** The verify page decodes credentials; it does not validate JWS, resolve issuer DIDs, or check revocation status. A "checks passed" verdict means the digest and the ledger anchor line up — nothing about issuer identity.
- **Simulated Identus mode is not a trust chain.** It produces credential-shaped records for demos (`alg: none`, stub signature) and the verify page marks them as proving nothing. Only the Fly Cloud Agent mode involves real DIDs and signatures.
- **PRISM DIDs are not externally resolvable.** The Fly PRISM node runs against its own database with no Cardano ledger backing, so published DIDs resolve only inside this stack. A third party cannot resolve them.
- **Fly stacks are ephemeral and single-tenant.** One app per kind per user, no multi-region, no autoscaling, and destroy is the intended cleanup path.
- **Log retrieval is best-effort.** With no Machines log API, a container that dies instantly can still outrun the boot-log read.
- **Validation is structural, not full FHIR conformance.** It checks the IPS document skeleton, required sections and LOINC codes and reference resolvability — it is not a substitute for the official validator or terminology server checks.
- **Not for real patient data.** Nothing here has been through clinical safety assurance or DPIA.

---

## What we would do differently next time

1. **Read the upstream compose and init scripts before writing a single machine spec.** Every hard failure in the table above — the application roles, the dev preset, the IPS-irrelevant env vars — was already answered in `midnight-local` and the Identus compose files. Porting a compose stack to Fly Machines is a *translation* job; do the reading first.
2. **Build the diagnostics path before the happy path.** Log capture, exit-code reporting and the step timeline were retrofitted while already blocked. Given the Machines API has no log endpoint, a boot-log tee and an `exec` reader should be part of the *first* machine spec, not the fifth.
3. **Never ship a speculative config change.** Two guesses (wallet seed, `POSTGRES_*`) added noise and delayed finding the real cause. Rule: no env var or flag goes in without an upstream source that says it's required.
4. **Model provisioning as a declarative state machine.** Instead of imperative "create these machines, then patch them", express a desired stack spec and write a reconcile loop. The three separate repair functions exist because the original code couldn't converge an existing stack to a new spec.
5. **Treat Postgres bootstrap SQL as versioned migrations, not an init script.** Init-only-on-empty-volume is a trap: it makes every schema-level fix a destroy-and-recreate. A migration runner that is safe to re-run would have removed the "Fix agent DB" workaround entirely.
6. **Pin digests, not just tags.** `latest` broke a demo; tags can still be re-pushed. Pin by digest and record the resolved digest in `fly_deployments` so a stack is reproducible.
7. **Have a fast smoke test separate from the full flow.** A "stack healthy?" probe that runs in seconds — node RPC responds, indexer answers a trivial GraphQL query, agent returns `/_system/health`, Postgres has all four databases and roles — instead of discovering breakage eight steps into a UI flow.
8. **Split the IPS work from the infrastructure work sooner.** The clinical logic (builder, validator, digest) is pure, testable and was never the problem; it should have been unit-tested and frozen early so infrastructure debugging couldn't destabilise it.

---

## Local development and setup

Requirements: Node.js (or Bun) and a Fly.io organisation token.

```sh
git clone https://github.com/arunnadarasa/ipsmidnight.git
cd ipsmidnight
npm i
npm run dev        # http://localhost:8080
```

Configuration:

- **Lovable Cloud** (database, auth, storage) is wired automatically — `VITE_SUPABASE_*` values land in `.env`.
- **`FLY_API_TOKEN`** — a Fly.io organisation token, stored as a project secret and read only inside server-function handlers. Without it, the Deploy console is read-only.

Typical flow:

1. Sign in (email or Google).
2. **Deploy → Provision IPS stack** and watch the timeline until both stacks are healthy. If the agent stalls on database migrations, use **Fix agent DB**.
3. Compile and deploy the contract (see [The Compact contract](#the-compact-contract)).
4. **IPS** → build or load a sample bundle → validate → save.
5. **Identus** → publish a DID → issue a credential over the digest.
6. **Midnight** → anchor the digest.
7. **Verify** → run the three passes against the bundle, credential and anchor.
8. **Deploy → Destroy** when finished; Fly bills for running machines and volumes.

Scripts: `npm run dev`, `npm run build`, `npm run lint`, `npm run format`.

---

## Reference links

### International Patient Summary / FHIR
- https://international-patient-summary.net/
- https://international-patient-summary.net/ips-links-to-standards-and-specifications/
- https://hl7.org/fhir/uv/ips/en/
- https://github.com/HL7/fhir
- https://github.com/HL7/fhir-ips
- https://github.com/HL7/CDA-IPS
- https://build.fhir.org/ig/HL7/CDA-IPS/fp-db11d3be-6643-471a-91d3-be6643e71a7a.html
- https://github.com/NHSDigital/NHSEngland-FHIR-SCR-IPS

### This project
- https://github.com/arunnadarasa/ipsmidnight (this repository)

### Midnight
- https://docs.midnight.network/llms-full.txt
- https://docs.midnight.network/relnotes/network (network endpoints)
- https://github.com/midnightntwrk/midnight-local
- https://github.com/arunnadarasa/flymidnight (end-to-end Midnight Undeployed + Fly.io reference)

### Hyperledger Identus
- Identus Cloud Agent and PRISM node images: `identus/identus-cloud-agent:1.40.0`, `identus/prism-node:2.5.0`

### Origin

This repository started from a single prompt: *"Create an app for International Patient Summary (IPS) using the Lovable skill for Identus and Midnight. It needs to use Midnight Undeployed Network and use fly.io for docker server proof"*, drawing on the earlier Lovable projects **Hyperledger Identus Catalyst**, **Hyperledger Identus NHS** and **Midnight Blockchain Catalyst**.

---

Built with [Lovable](https://lovable.dev) — continue in the [editor](https://lovable.dev/projects/9101c7d8-5a00-410e-8d44-dd50ade8c6e7). The source lives on GitHub at [arunnadarasa/ipsmidnight](https://github.com/arunnadarasa/ipsmidnight). Changes in Lovable commit straight to this repository, and pushes to `main` sync back.
