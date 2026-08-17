# Fix the indexer: the chain produces blocks, the indexer has none

## What I verified just now

- Proof server is healthy: `GET https://creative-midnight.fly.dev:6300/health` → `{"status":"ok"}`.
- Identus agent is healthy: `GET https://creative-identus.fly.dev/_system/health` → `200`.
- The indexer answers GraphQL but has an **empty chain**:
  `POST /api/v4/graphql {block{height hash}}` → `{"data":{"block":null}}`,
  while your Fly logs show the node importing block `#38` and finalising `#36`.

So the node is authoring fine and the indexer is up — but the indexer never
ingested a single block. That is why the Midnight page prints "reachable, no
block yet" next to a green dot, and why "Node RPC" stays grey.

## Why the stack still says "ready" (a reporting bug on top of the real bug)

Readiness is computed as `indexer.ok && proof.ok`. `indexer.ok` only means the
GraphQL endpoint answered, so an indexer with zero blocks is reported as ready
and the timeline completes. Anything downstream that needs chain state (contract
deploy, anchor confirmation) then silently cannot work — which is why the anchor
row stays `queued` and the contract stays undeployed.

## Most likely cause of the empty indexer

The indexer reaches the node over Fly's private network at
`ws://midnight-node.process.creative-midnight.internal:9944`. Fly's `.internal`
DNS returns **IPv6-only** addresses, and a Substrate-based node binds its RPC to
localhost unless told otherwise. If the node's RPC is not listening on `[::]`
with external access allowed, every indexer connection attempt is refused and
the indexer keeps serving an empty chain instead of crashing.

This is unconfirmed until I read the indexer's own log, so step 1 of the work is
confirmation, not a speculative change.

## Plan

1. **Confirm from the indexer side.** Pull the indexer machine's log tail (the
   same Fly log path the Identus half already uses) and look for the node
   connection error. Also resolve the node's 6PN address and try the RPC from a
   machine on the same network. This names the cause instead of guessing.
2. **Fix the node's RPC exposure** (expected fix): give the node an explicit
   RPC binding on all IPv6 interfaces with external connections and permissive
   CORS, keeping the working `CFG_PRESET=dev` boot path. If the log instead
   points at the indexer (wrong URL shape, missing network-id, storage
   migration), fix that side.
3. **Make readiness honest.** The indexer probe already returns a block height;
   treat "GraphQL up but height is null/0 after the grace window" as
   *syncing*, not ready — a distinct amber step with the text "indexer
   connected, no blocks ingested" and a repair hint. `allReady` requires a
   non-null block height, so nothing downstream starts against an empty chain.
4. **Surface the block height** on the Midnight page and the Deploy timeline so
   the indexer state is visible at a glance.
5. **Re-apply and verify.** Use the existing repair action (it re-applies specs
   and restarts machines; chain data lives on the volume and is preserved) and
   confirm `block { height }` climbs.

## Also visible in the screenshots (follow-on, not the bug)

The anchor stays `queued` because submitting it needs the deployed
`IpsAnchorRegistry` contract, and `src/data/midnight-contract.undeployed.json`
still holds the zero address. Contract deployment is a sandbox script step that
can only succeed once the indexer has chain state — so it runs after step 5.
I'll deploy it and record the real address in the same pass if the indexer
recovers.

## Technical notes

- Files: `src/lib/midnight/fly.server.ts` (node spec, indexer log tail, probe
  semantics), `src/lib/midnight/shared.ts` (RPC flags/URL helpers if needed),
  `src/lib/stack-steps.ts` + `src/components/deploy/StackTimeline.tsx` (syncing
  state), `src/routes/app.midnight.tsx` (block height display),
  `src/lib/stack.functions.ts` (`ready` no longer true without a block).
- No change to Identus, no destroy/reprovision, and the node volume
  (`midnight_chain`) is untouched.

## Verify

1. Indexer log shows a live node subscription, no connection refusals.
2. `block { height }` returns a rising number over two polls.
3. Midnight page shows the height; Deploy timeline shows ready only then.
4. Contract deploy writes a real address, and a queued anchor can be submitted
   and confirmed.
