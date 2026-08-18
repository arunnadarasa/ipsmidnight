# Fold IPS Compass learnings back into the Identus and Midnight skills

Both skills are currently missing everything this build discovered — the Postgres role
requirement that broke Identus boot for hours, the Fly private-DNS quirk, the node RPC
tunnel that finally let the indexer see blocks, the runner-machine pattern that moved
contract deploy/anchor from the chat into the UI, and the honesty rules from the external
code review (issue #1).

Active skills under `.workspace/skills/` are read-only and reset every message, so the
update goes through drafts: write the revised skill folders under `.agents/skills/`, then
apply each draft so it replaces the installed version.

## 1. `hyperledger-identus`

Add to **Hard-won invariants** and a new workflow:

- **Identus 1.40 requires pre-created Postgres roles.** The Flyway migrations connect as
  `pollux-application-user`, `connect-application-user`, `agent-application-user`. Without
  them the agent dies with `Main child exited normally with code: 1` and the real cause
  (`ERROR: role "pollux-application-user" does not exist`) is buried deep in a ZIO trace.
  The Postgres init script must create each role plus schema/table grants.
- **Pin Postgres to `13-alpine`.** On `16-alpine` the Flyway migrations fail with a syntax
  error near `FORMAT` (reserved in newer Postgres). Never move this pin without re-running
  a first-boot migration.
- **Fly private DNS keys off `fly_process_group` metadata, not the machine name.** Machines
  created without it are unresolvable, and the agent fails with `UnknownHostException` on
  the DB host. Set `metadata: { fly_process_group: <name> }` on every machine.
- **Derive `DEFAULT_WALLET_SEED` deterministically** from the app identity. A random seed
  per boot makes the wallet/agent resource acquisition fail on restart.
- **Read boot logs through the machine `exec` API, not the log stream.** A crash-looping
  machine never keeps a log connection open long enough; `exec` on a short-lived read of
  the JVM log is what surfaced the actual exception in the UI.
- New workflow: **Repair the agent database** — recreate the Postgres machine with the
  role-aware init script, then restart the agent (the "Fix agent DB" action), because
  editing env on the existing machine cannot retro-create roles.

## 2. `lovable-midnight`

New section `2026-08 update — ipsmidnight lessons (Undeployed on Fly + UI-driven deploy)`:

- **Publish node RPC as a pure `tls` service on 9944 through the Fly edge.** `.internal`
  (IPv6-only vs. an IPv4-bound node) and `.flycast` both fail; Fly's `http` handler closes
  the WebSocket mid-proof-submission. `wss://<app>.fly.dev:9944` is the only combination
  where the indexer syncs and long proof submissions survive.
- **The indexer silently serves an empty chain when it can't reach the node** — no error,
  just block 0 forever. Probe node reachability from inside the indexer machine and report
  `flycast: present/absent` and public-IP state as facts read back from Fly, never assumed.
- **Runner-machine pattern**: contract compile/deploy/anchor/verify needs a persistent disk
  and minutes-long connections, which the app runtime does not have. Add a 4th machine in
  the same Fly app (Node + SDK + contract volume), drive it with the Machines `exec` API,
  and have the scripts print machine-readable result lines the UI can parse and tail.
- **SDK v4 wallet/provider gotchas**: `privateStoragePasswordProvider` has a minimum length;
  `httpClientProofProvider` must be passed the same `NodeZkConfigProvider` instance, or the
  proof server answers `400 Bad Request` on `/check`.
- **Verification honesty (from the public code review)**: the only real proof is ledger
  membership — `commitments.member(commitment)`. Persist the salt with the anchor or the
  commitment can never be re-derived; a stored tx hash is not verification. Keep credential
  claims minimised (no raw PII — derive `over18` instead of shipping a DOB), and label
  simulated or unresolvable artefacts as unverifiable instead of green.
- **Key/state hygiene**: `.env`, `midnight-level-db/`, and `*.tgz` toolchain bundles stay
  out of git; dev seeds and storage passwords come from `process.env` with a fallback, never
  hardcoded literals.
- **Graceful degradation on a missing `FLY_API_TOKEN`**: status functions must return an
  "unconfigured" state so the page still renders, instead of throwing during load.

## Technical notes

- Drafts: `.agents/skills/hyperledger-identus/` (SKILL.md + the seven existing `references/`
  files carried over, with `failure-modes.md` and `fly-machine-config.md` extended) and
  `.agents/skills/lovable-midnight/SKILL.md`.
- Then `skills--apply_draft` on each draft path to install them.
- Existing content is preserved; edits are additive so nothing already-verified is lost.
- No application code changes in this task.
