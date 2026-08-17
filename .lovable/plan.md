# Rewrite README.md as full project documentation

Replace the current link-dump README with a detailed engineering document for IPS Compass, keeping the existing reference links in an appendix.

## Structure

1. **Overview** — what IPS Compass is: a clinical console that builds/validates FHIR International Patient Summary bundles, issues verifiable credentials via Hyperledger Identus, and anchors bundle digests on a Midnight Undeployed network, with all Docker infrastructure provisioned on Fly.io from inside the app.
2. **Architecture diagram** (```text ASCII) — browser app → TanStack Start server functions → Lovable Cloud (Postgres + auth + RLS) and Fly Machines API → Identus stack (postgres, prism-node, cloud-agent) + Midnight stack (node, indexer, proof server).
3. **Feature walkthrough**, one subsection per route: Dashboard, IPS workspace (guided builder + upload + sample bundles + structural/LOINC validation + SHA-256 digest), Identus (simulated vs Fly cloud-agent mode, DIDs, connectionless issuance), Midnight (stack status, anchoring), Deploy (unified provisioning with progressive step timeline), Verify (three-pass check), Activity log.
4. **Data model and security** — tables (profiles, user_roles, fly_deployments, ips_bundles, midnight_anchors), RLS-per-user, roles in a separate table with a security-definer function, PHI kept server-side, secrets (Fly token) never in client code.
5. **Contracts** — `contracts/IpsAnchorRegistry.compact` append-only commitment registry, compiled with the Compact toolchain in the Linux sandbox, ZK keys published to `public/`, deployment via `scripts/deploy-midnight.mjs`.
6. **Best practices we followed** — server-only modules (`*.server.ts`) vs client-safe `*.functions.ts`, no browser-only Midnight imports during SSR, semantic design tokens instead of hardcoded colours, mobile-first layout rules, idempotent provisioning/repair actions, surfacing provider HTTP status and body instead of generic 500s.
7. **Issues encountered and how they were solved** — a table with symptom → root cause → fix, covering the debugging history:
   - Identus `UnknownHostException` on `.internal` DNS → missing `fly_process_group` metadata on machines.
   - Midnight node crash loop on CLI flags → switch to node image with `CFG_PRESET=dev` plus a persistent volume for chain data.
   - Indexer/node unreachable → bind to IPv6 (`[::]`, `APP__INFRA__API__ADDRESS="::"`).
   - Cloud agent exit code 1 masked by prism-node logs → boot-log tee plus exec-based log tail surfaced in the UI.
   - Definitive agent failure `role "pollux-application-user" does not exist` → Postgres init SQL creating one login role per Identus database with in-database grants; repair action recreates only the Identus Postgres.
   - Speculative fixes that were removed after research (`DEFAULT_WALLET_SEED`, duplicate `POSTGRES_*` group) — kept as a lesson about verifying before configuring.
   - Spinning health probes → derive step state from machine state and stop downstream probes on boot failure.
8. **Known limitations** — Undeployed/dev network only, crash-looping machines intermittently reject exec log reads, simulated Identus mode is not a real trust chain, no production key management.
9. **What we would do differently next time** — pin every image digest and validate env contracts before first boot; read upstream compose/init scripts before writing machine specs; build the log/diagnostics path first so failures are readable from step one; model provisioning as an explicit state machine with declarative desired state and reconcile; separate a fast "healthy stack" smoke test from the full flow; treat Postgres bootstrap SQL as versioned migrations; avoid speculative config changes without an upstream source.
10. **Local development and setup** — install, dev server, required secrets (Fly token, Lovable Cloud auto-wired), how to compile the Compact contract, how to provision and destroy stacks.
11. **Reference links appendix** — all existing IPS/FHIR, Midnight, and Identus links preserved, grouped by topic; the original prompt text kept as a short "Origin" note.

## Technical notes

- Single file change: `README.md` (full rewrite). No source, schema, or config changes.
- Facts drawn from the existing code (`src/lib/identus/*`, `src/lib/midnight/*`, `src/lib/stack*.ts`, `src/routes/app.*.tsx`, `contracts/`, `supabase/migrations/`) so the document matches the actual implementation; I will re-read those files while writing rather than describing from memory.
- Plain GitHub-flavoured markdown, no emojis; ```text for the diagram.
