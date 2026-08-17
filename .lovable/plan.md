# Debug the Identus cloud agent boot failure

## What the screenshots show

- **Midnight is now healthy.** The node authors and imports blocks (`Imported #15`,
  `Starting consensus session`, `Prepared block for proposing at 16`), the stack
  reports ready in 1m 22s, and all three machines are `started`. The upstream
  image/args change worked; nothing more to do on that half.
- **Identus is stuck at step 5 of 8**, "Agent health: system". The cloud-agent log
  reaches the end of normal startup — `HTTP server endpoint is setup as
  https://creative-identus.fly.dev`, `DIDComm server endpoint is setup as
  https://creative-identus.fly.dev:8090` — and then, two seconds later, throws:
  `cats.free.Free.1$$anonfun`, `zio.interop.ZioMonadError.tailRecM.loop`,
  `cats.effect.kernel.Resource.loop$1`. That is a ZIO/cats resource acquisition
  failing *after* the endpoints are configured, so the HTTP port never starts
  answering and the health probe never turns green.

The visible frames are only the stack trace, not the exception message, so the
exact cause is not yet proven — the frames are consistent with the agent failing
while acquiring a resource during wallet/secret-storage initialisation.

## Plan

1. **Get the real error instead of guessing.** Add a server-side log read for the
   cloud-agent machine (Fly's NATS-free log endpoint via the app's log API) and
   surface the last error line as the `detail` on the failed
   "Agent health: system" step, next to the exit-code detail we already show.
   This is step one and gates the rest.
2. **Fix the most likely cause: a missing default-wallet seed.** With
   `DEFAULT_WALLET_ENABLED=true` and `SECRET_STORAGE_BACKEND=postgres`, the agent
   needs a `DEFAULT_WALLET_SEED` (hex-encoded BIP39 entropy) to initialise the
   wallet's secret storage; without it initialisation aborts exactly at this point
   in the boot sequence. Generate a stable seed per stack, store it alongside the
   admin key on the deployment record, and pass it to the machine so a repair does
   not invalidate previously issued DIDs.
3. **Only if the log says otherwise**, apply the cause the log names rather than
   the seed fix — e.g. a gRPC failure reaching `identus-prism-node` on 50053, or a
   Postgres connection/migration error on one of the four databases.
4. **Roll the change onto the existing `creative` stack with Repair config** — no
   destroy, no re-provision — then Check.

## Technical notes

- Files: `src/lib/identus/fly.server.ts` (machine env + a `machineLogs` reader),
  `src/lib/identus/fly-shared.ts` (seed helper/constant),
  `src/lib/stack.functions.ts` and `src/lib/stack-steps.ts` (carry the log line
  into the failed step), `src/components/deploy/StackTimeline.tsx` if the detail
  needs more room.
- The seed is a secret-shaped value: persist it on the deployment row, never
  render it in the UI.
- No schema change beyond storing the seed on the existing deployment metadata.
- Midnight specs stay untouched.

## Verify

1. Repair the `creative` stack, then Check.
2. Identus reaches all four green probes (system, DID registrar, issuance,
   connections) within the 300s grace period.
3. Publishing an issuer DID succeeds from the Identus page.
4. Midnight stays green with a climbing block height.
