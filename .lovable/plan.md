# Debug the Midnight node crash-loop (and align both stacks with upstream)

## What the new logs show

The Identus half is fixed: the PRISM node screenshots now show normal operation
(`SubmissionService` refreshing transactions, DB reachable), so the private-DNS
`fly_process_group` change worked.

The failing machine is the **Midnight node**. Its logs are a full partner-chains
configuration dump (`block_stability_margin`, `mc__first_epoch_timestamp_millis`,
`federated_authority_config_file`, …) followed by:

```text
INFO Main child exited normally with code: 1
INFO Starting clean up.
reboot: Restarting system
```

That pattern — dump every config key, then exit 1 — is the node rejecting its
startup configuration/arguments, not a runtime failure. It restarts forever, so
the indexer never sees a chain and the timeline never completes.

## What upstream actually runs

The official `midnightntwrk/midnight-local-dev` standalone stack (verified this
turn) runs the node with **no CLI arguments at all** — the `dev` preset already
authors blocks — and uses newer image tags:

```yaml
node:  midnightntwrk/midnight-node:1.0.0        # env: CFG_PRESET=dev, SIDECHAIN_BLOCK_BENEFICIARY
indexer: midnightntwrk/indexer-standalone:4.3.3 # + APP__INFRA__SPO_NODE__URL
proof: midnightntwrk/proof-server:8.1.0         # cmd: midnight-proof-server -v
```

Our machine spec differs in three ways that can each produce exit 1:
`--alice --force-authoring --experimental-rpc-endpoint …` passed as an args array,
`SHOW_CONFIG=false` (not an upstream variable), and the older 0.22.5 tag whose
CLI surface predates `--experimental-rpc-endpoint`.

## Fixes

1. **Confirm the cause before changing images.** Pull the node machine's exit
   code and last log lines through the Fly API in the existing diagnostics path,
   so the timeline shows the real reason instead of a spinner. This is step one —
   the dump-then-exit reading above is strong but not yet proven from the API.
2. **Drop the custom node arguments and `SHOW_CONFIG`.** Run the node exactly as
   upstream does: `CFG_PRESET=dev` + `SIDECHAIN_BLOCK_BENEFICIARY`, no `init.cmd`.
3. **Move to the upstream image set**: node `1.0.0`, indexer `4.3.3`, proof
   server `8.1.0`, keeping the proof server's `midnight-proof-server -v` command.
4. **Add the indexer key we were missing**: `APP__INFRA__SPO_NODE__URL` pointing
   at the node's 6PN address, alongside the existing `APP__INFRA__*` set and the
   IPv6 `APP__INFRA__API__ADDRESS`.
5. **Keep IPv6 reachability without the experimental flag.** If, after the args
   are removed, the node's RPC turns out to bind IPv4-only on 1.0.0, re-introduce
   the IPv6 listen address as the *only* extra argument rather than the whole
   trio — verified by an indexer probe reporting a rising block height.
6. **Persist chain data.** Attach a Fly volume mounted at `/node/chain` for the
   node machine so a restart or repair does not invalidate a deployed contract
   address.
7. **Reuse the existing Repair action** to roll all of this onto the already
   provisioned `creative` stack; no destroy, no re-provision.

## Technical notes

- Files: `src/lib/midnight/shared.ts` (image tags, indexer env),
  `src/lib/midnight/fly.server.ts` (node spec, volume, diagnostics),
  `src/lib/stack.functions.ts` and `src/lib/stack-steps.ts` (surface machine exit
  code / last log line as a failed step), `src/components/deploy/StackTimeline.tsx`.
- No database migration, no schema change.
- Identus machine specs stay as they are — that half is healthy.

## Verify

1. Repair the `creative` stack from the Deploy page, then Check.
2. Node machine stays `started` with no reboot loop; block height climbs.
3. Indexer probe reports `block #N` with N increasing; proof server answers on 6300.
4. Identus stays green on all four probes.
