# Deploy: what's left after both halves went green

## Where the stack actually stands

Your screenshots show both halves healthy: Identus ready, Midnight ready, the indexer
following the chain at block #13, and the Fly dashboard listing `creative-identus` and
`creative-midnight` as deployed with 3 machines each. Fly logs confirm the node is
authoring and finalising blocks. Nothing on the provisioning side is broken any more.

One thing is genuinely unfinished, and it is the reason the Anchors panel shows a queued
summary with no transaction id: `src/data/midnight-contract.undeployed.json` still holds
the placeholder address (all zeros) and `deployTx: null`. The console reads that file,
sees the placeholder, and writes anchors with `contract_address: null` in `queued` state.
So anchors can never move to `confirmed` — there is no contract to call.

## Plan

1. **Deploy `IpsAnchorRegistry` against the live stack.** Run the existing
   `scripts/deploy-midnight.mjs` in the Lovable sandbox, pointed at the running
   endpoints (`https://creative-midnight.fly.dev/api/v4/graphql` and the proof server on
   port 6300). Install the Midnight JS deploy dependencies first; the contract is already
   compiled under `contracts/managed/ips-anchor-registry`.
2. **Record the real address.** The script writes the deployed address, deploy tx and
   timestamp back into `src/data/midnight-contract.undeployed.json`. Once that lands, the
   Anchor contract panel flips from "written and compiled, not yet deployed" to showing
   the address and tx, and newly queued anchors carry a real `contract_address`.
3. **Prove the anchor round-trip.** Queue an anchor from a saved summary, submit it, and
   confirm the existing verification path reports it at a block height. If submission
   fails, fix that path with the error the ledger returns rather than guessing.
4. **Backfill the already-queued anchor** so the row that is currently stuck without a
   contract address is re-pointed at the deployed contract instead of sitting forever in
   `queued`.
5. **Only if the deploy itself fails**, capture the failure (proof server rejection,
   wallet funding on the dev chain, indexer WS handshake) and fix that specific cause —
   no speculative changes to the Fly specs, which are now working.

## Technical notes

- Files touched: `src/data/midnight-contract.undeployed.json` (written by the script),
  and only if step 3 or 5 uncovers a real fault, `scripts/deploy-midnight.mjs`,
  `src/lib/midnight/fly.functions.ts` (anchor submit/confirm), or
  `src/routes/app.midnight.tsx` (panel copy).
- No Fly machine, volume or spec changes; the chain volume and current block height are
  untouched, so the deployed address stays valid.
- No database schema change; the anchor rows already have `contract_address` and
  `status` columns.

## Verify

1. `midnight-contract.undeployed.json` holds a non-zero address and a deploy tx.
2. The Midnight page's Anchor contract panel shows both, not the "not yet deployed" copy.
3. A queued anchor reaches `confirmed` with a block height on the Anchors list.
