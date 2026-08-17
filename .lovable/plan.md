# Fix the indexer: node authors blocks, indexer ingests none

## What the evidence shows

- The Fly logs confirm the node is healthy and authoring: `Imported #6`, `Idle (0 peers), best: #6`, BEEFY worker running. The proof server is up and answering `/health` on `0.0.0.0:6300`.
- The console's own probe is the useful signal: `node RPC: 200 local 000 flycast`. From inside the node machine, `http://127.0.0.1:9944/health` answers 200, but `http://<app>.flycast:9944/health` returns `000` — no connection at all.
- The indexer probe adds `no-curl no-getent`, so that container has neither tool and the current probe cannot say anything about DNS from the indexer's side.
- `indexer log: log api 401` means the log fallback we use for the indexer is rejected by the token, so no indexer-side error text reaches the timeline.

So the wiring, not the chain, is broken: `APP__INFRA__NODE__URL=ws://<app>.flycast:9944` points at a Flycast address that does not currently accept connections, even from inside the app. The node's RPC listener is IPv4-only, which is why the plain 6PN `.internal` name failed before and Flycast was introduced as the bridge — but the bridge itself is unverified: the private IP allocation is fired through GraphQL with its response deliberately ignored, so a failed or missing Flycast allocation looks identical to success.

Note the diagnosis of *why* Flycast is dead is currently unconfirmed (most likely no private IP on the app, or the proxy not accepting the port). Step 1 confirms it before anything is changed.

## The fix

1. **Confirm, then guarantee, the Flycast address.** After allocating IPs, read the app's IP list back from Fly and check a private (Flycast) address actually exists. Surface it in the Midnight diagnostics line (`flycast: present/absent`) so the timeline states the fact instead of implying it.
2. **Stop relying on Flycast as the only path.** Publish the node's RPC through the Fly edge on a dedicated port and point the indexer at that URL. The edge terminates on IPv4 inside the container, which is exactly what the IPv4-bound Substrate RPC needs, and it does not depend on any private-IP allocation. The indexer keeps a single `APP__INFRA__NODE__URL` / `APP__INFRA__SPO_NODE__URL` value, derived in one place (`nodeRpcWsUrl`).
3. **Make the probes work on a toolless container.** Replace the `curl`/`getent` calls in the indexer probe with a shell-only TCP check plus an explicit "probe unavailable in this image" result, so the timeline never again reports `no-curl no-getent` as if it were a finding.
4. **Read the indexer's own log the way the agent log is read** — through the machine `exec` path rather than the app log API that returns 401 — and show its last error line in the "Indexer syncing" hint.
5. **Fold all of this into the existing "Fix indexer" button** so a stuck stack is repaired in place: re-allocate IPs, re-apply the node and indexer specs, restart the indexer last so it reconnects to a node that is already reachable.

## Technical notes

- Files: `src/lib/midnight/shared.ts` (node RPC URL derivation), `src/lib/midnight/fly.server.ts` (IP verification, node service ports, probes, indexer log via `exec`, `repairMidnightStack` ordering), `src/lib/stack-steps.ts` (hint text for the indexer step), and the Midnight diagnostics rendering in `src/routes/app.deploy.tsx`.
- The node's chain volume is untouched, so the chain height and any deployed contract address survive the repair.
- Exposing the dev-chain RPC through the edge is acceptable for this Undeployed demo stack (throwaway `CFG_PRESET=dev` chain, no funds), and it is the same trade-off the public proof server already makes. It will be called out in the console copy.
