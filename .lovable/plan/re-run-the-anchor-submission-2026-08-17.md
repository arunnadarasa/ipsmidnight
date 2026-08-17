# Re-run the anchor submission

The contract `IpsAnchorRegistry` is deployed on the Midnight undeployed network at `b5ecda37…a2e2`. The last anchor submission run timed out during proof generation, so at least one anchor row is still queued with no transaction ID.

## What happens

1. Read the queued anchor rows from the database to get their commitment hashes (and confirm how many are still pending).
2. Re-run `scripts/anchor-midnight.mjs` in the sandbox for each queued commitment, pointed at the live Fly stack (`creative-midnight`) — indexer GraphQL, proof server on 6300, node RPC over the TLS tunnel on 9944.
3. Run it in the background with a generous window (proving takes several minutes) and poll the log rather than blocking on a short timeout, which is what cut the previous attempt short.
4. On success, record the returned transaction ID and block height back onto the anchor row so the console shows the anchor as confirmed instead of queued.
5. If proving still times out or the node RPC drops, report the exact failure from the script log and stop — no silent retries.

## Notes

- No app code changes are planned; this is an operational run plus a database write-back of the resulting transaction IDs.
- The script reuses the same genesis seed, private-state ID, and storage password as the deploy script, so the existing private state stays loadable.
- If the run reveals the proof server or indexer is unreachable, the fix is to press Repair / Fix indexer on the Midnight card first, then re-run.
