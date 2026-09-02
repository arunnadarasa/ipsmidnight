# Learnings from `midnight-did` and `midnight-verifiable-credentials`

## What the two sources actually are

**`midnight-did`** is a real, shipping reference implementation of a new `did:midnight` method. Two npm packages are published at `0.5.0` (after a long `0.4.0-snapshot.*` / `0.5.0-rc*` stream):

- `@midnight-ntwrk/midnight-did-contract` — a Compact contract holding DID state on-ledger (verification methods, relations, services, aliases, metadata) with lifecycle circuits.
- `@midnight-ntwrk/midnight-did` — the mapping layer from that ledger state to W3C DID Core documents.

Resolver service, DID manager UI, and key custody live in a separate repo (`midnight-did-resolver`), with no packages found published on npm. The DID identifier syntax — including how it embeds the deploying contract's address — was still an open design discussion as of late 2025, so it is not a stable target yet.

**`midnight-verifiable-credentials`** is much newer (created Dec 2025) and still bootstrapping: no npm packages found published, and its open issues are dominated by dev-tooling/SDLC work rather than VC features. No documented answer yet on credential formats (JWT / SD-JWT / BBS+), selective disclosure, or revocation lists.

## The one learning that matters for this project

`did:midnight` DIDs are ordinary Midnight ledger objects, resolvable through the same indexer read path we already built for `scripts/verify-midnight.mjs`. That is a credible fix for our single worst honesty gap: `NODE_LEDGER: "in-memory"` on the PRISM node means our `did:prism:...` issuer DIDs exist only inside that Fly container and cannot be resolved by any outside verifier.

What these projects do **not** fix, contrary to first impression:

- **No JWS verification.** That is the VC repo's scope, and it is too immature to adopt. `app.verify.tsx` would still have to say "signature not checked" unless we verify JOSE ourselves or use Identus's own verification.
- **Simulated credentials** are our own demo choice, untouched.
- **Commitment-only anchoring** is a data-minimisation decision in `IpsAnchorRegistry.compact`, orthogonal to DID/VC tooling. Adopting `did:midnight` means deploying a *second* contract, not changing ours.
- **No new networks.** Nothing indicates support beyond the Undeployed/dev network we already run.

Plus a lesson that repeats one we already paid for with `compact-js@2.5.3`: a `0.5.0` package whose identifier format is still under discussion is exactly the "caret on an alpha" trap. Any adoption must pin exact versions and expect breakage on the next `0.x` bump.

## Proposed action — document now, spike later

No production migration. Two documentation changes plus one clearly-scoped optional spike.

### 1. README honesty upgrade (no code change)

In **Known limitations**, replace the bare "PRISM DIDs are not externally resolvable" note with the same statement plus the known remedy and why we have not taken it: `did:midnight` (`@midnight-ntwrk/midnight-did@0.5.0`) puts DID documents on the Midnight ledger, resolvable by the indexer path we already use, but its identifier syntax is unstable and its VC counterpart is pre-alpha.

Add a **Ecosystem watch** subsection under *What we would do differently* recording: DID layer has a Midnight-native path; VC layer does not yet; the two must move together or the trust chain is half-finished.

### 2. `lovable-midnight` skill update

Append a short dated subsection so future Midnight work inherits this without re-researching:

- `did:midnight` exists — `@midnight-ntwrk/midnight-did` + `-did-contract` at `0.5.0`; DID state is a Compact contract, resolution is an indexer read, resolver/key-custody live in `midnight-did-resolver`.
- Do **not** assume a Midnight-native VC stack exists yet; `midnight-verifiable-credentials` publishes nothing. Signature verification remains your own problem (JOSE) or an external agent's (Identus).
- Adopting DIDs does not adopt VCs. Migrating identity without credential verification produces a DID that resolves but a credential nobody can check — worse than the status quo because it looks complete.
- Pin exact `0.x` versions; treat identifier-format changes as breaking.
- `did:midnight` does not replace an application anchoring contract — it is a second contract, a second proving flow, a second thing that can be down.

### 3. Optional spike (only if you want it)

A read-only evaluation, entirely additive and behind a flag: deploy `midnight-did-contract` on our existing Undeployed stack via the runner, mint one issuer DID, and resolve it back through the indexer with a script mirroring `verify-midnight.mjs`. Success criterion is a resolvable DID document; nothing in the Identus or IPS path changes. If it works, credential issuance stays on Identus until the VC repo publishes packages.

## Technical notes

- Files touched by items 1–2: `README.md`, `.agents/skills/lovable-midnight/SKILL.md` (append only, then re-apply the draft).
- Item 3 would add `scripts/resolve-did-midnight.mjs`, one runner job kind in `src/lib/midnight/runner.server.ts`, and a pinned dependency group entry in `src/lib/midnight/shared.ts` — no schema change, no change to `IpsAnchorRegistry.compact`, no change to the anchoring UI.
- Several facts stay open until someone browses the repos directly: the final `did:midnight` syntax, whether the VC repo documents SD-JWT/BBS+/status lists, and the network support matrix. The README wording should reflect that these are unconfirmed rather than stating them as settled.
