# Deploy the anchor contract — the last missing piece

## What I verified just now

- Indexer is following the chain: `block { height }` → **47**.
- Proof server: `{"status":"ok"}` on port 6300.
- The node RPC now works end to end over the tls-only tunnel I changed last turn:
  a WebSocket to `wss://creative-midnight.fly.dev:9944` opens and answers
  `system_chain` → `"undeployed1"`. That was the failure that killed the previous
  deploy attempt (socket closed mid-extrinsic).
- `src/data/midnight-contract.undeployed.json` still holds the all-zero address and
  `deployTx: null`, which is exactly why the console says "written and compiled, but
  not yet deployed" and why the queued anchor has no transaction id.

So nothing on the infrastructure side is broken any more. The remaining gap is that
`IpsAnchorRegistry` has never been deployed, so anchors cannot leave `queued`.

## Plan

1. **Run the deploy** from the sandbox scratch folder (`/tmp/midnight-deploy`, deps already
   installed, script identical to `scripts/deploy-midnight.mjs`), pointed at the live
   indexer, proof server and the now-working node RPC. First proof can take 30–120s.
2. **Record the real address** — the script writes address, deploy tx and timestamp into
   `src/data/midnight-contract.undeployed.json`, which flips the Anchor contract panel
   from the "not yet deployed" copy to the live address and tx.
3. **Backfill the stuck anchor** so the row currently sitting with `contract_address: null`
   is re-pointed at the deployed contract instead of staying `queued` forever.
4. **Prove the round-trip**: submit that anchor and confirm the verification path reports
   it at a block height.
5. **Only if the deploy fails**, fix the specific cause the ledger/proof server reports
   (wallet funding on the dev chain, private-state mismatch, zk artefact path) — no
   speculative changes to the Fly specs, which are now working.

## Technical notes

- Files touched: `src/data/midnight-contract.undeployed.json` (written by the script), and
  only if step 4 or 5 uncovers a real fault, `scripts/deploy-midnight.mjs` or
  `src/lib/midnight/fly.functions.ts` (anchor submit/confirm).
- No Fly machine, volume or spec changes — the chain volume and current height stay intact,
  so the deployed address remains valid.
- No database schema change; anchor rows already have `contract_address` and `status`.

## Verify

1. The JSON holds a non-zero address and a deploy tx.
2. The Midnight page's Anchor contract panel shows both.
3. The queued anchor reaches `confirmed` with a block height.
