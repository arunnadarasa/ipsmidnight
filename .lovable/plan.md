# Acting on the external code review (issue #1)

I read the reviewer's seven points against the current code. All seven are accurate as written — nothing to push back on. Below is what to change, ordered by how much it affects the trust story.

## What the review got right

| # | Finding | Confirmed in code |
|---|---|---|
| 1 | Credentials carry patient name + DOB, not "only the digest" | `src/lib/identus/fly.functions.ts` builds `patientName`, `summaryTitle`, `dob` claims |
| 2 | `verifyAnchorOnChain` never checks the commitment | `src/lib/midnight/fly.server.ts` queries `contractAction(address:)` and returns `ok = Boolean(hash)` |
| 3 | Commitment salt is discarded | `src/routes/app.midnight.tsx` generates `randomSaltHex()`, stores only digest + commitment |
| 4 | No signature verification; simulated credentials pass as real | `decodeCredential` is `atob`; simulated JWTs use `alg: "none"` and are not filtered on verify |
| 5 | Hosted issuance stores no credential | `credential_jwt` lands `null` at `OfferSent`, yet verify reports "credential exists" |
| 6 | `NODE_LEDGER: in-memory` means published DIDs are not externally resolvable | `src/lib/identus/fly.server.ts` |
| 7 | Committed key material | `midnight-level-db/` and `.env` are tracked; hardcoded `"11".repeat(32)` and storage password in both scripts |

## Fixes to make

**Minimise credential claims (1).** Issue only `summaryDigest` + `credentialType` in both the hosted and simulated paths. Drop `patientName`, `summaryTitle`, and `dob`. If age assurance is wanted later, add a derived `over18` boolean instead of a birth date. Update the README claim table to match.

**Make anchoring commitment-bound (2 + 3).**
- Persist the salt: add a `salt` column to `midnight_anchors` (RLS unchanged, owner-only) and store it when preparing an anchor, so the commitment is recomputable.
- Rewrite `verifyAnchorOnChain` to request `contractAction { state }`, run the generated `ledger(state)` reader, and return `ok` only when `commitments.member(commitment)` is true. Stop flipping every queued row to `confirmed`, and stop overwriting `tx_hash` with whatever hash the query returned — only write the hash when the commitment is actually present.
- Also switch the commitment to a domain-separated digest (`sha256("ips:anchor:v1|" + digest)`) as a fallback path so a verifier holding only the bundle can reproduce it.

**Gate the verify page honestly (4 + 5).** Select `simulated` and `state`/`credential_jwt` on the verify query. A simulated credential, or a hosted record still at `OfferSent` with a null JWT, must render as "not verifiable" — never as "verified end to end". Real JWS verification and DID resolution stay out of scope for now, but the page must say the signature is unverified rather than implying otherwise.

**Complete hosted issuance (5).** Poll the credential record until `protocolState` reaches `CredentialSent`/`CredentialIssued` before marking the row usable, and set `subject_did` to the holder rather than the issuing DID.

**Documentation honesty (6).** State plainly in the README that with an in-memory PRISM ledger the DIDs exist only inside that container and are not resolvable by outside verifiers.

**Key material hygiene (7).** Untrack `midnight-level-db/` and `.env`, add both to `.gitignore`, and read the deploy/anchor secret key and storage password from env vars with no committed default.

## Notes

Existing anchor rows have no salt, so they cannot be commitment-verified retroactively — they will show as "unverifiable, re-anchor to confirm" rather than silently passing. Deployed contract address and the already-confirmed block #397 anchor are unaffected.
