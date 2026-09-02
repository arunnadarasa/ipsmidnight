# Fix: the database probe can't find the Postgres machine's private address

## What the screenshots and code show

- The new error is not an authentication failure any more. It reads: "Could not determine the database machine's private address, so no remote login was attempted." The three role logins are then reported as rejected because the probe never had a host to connect to.
- Confirmed cause in `postgresProbeScript` (`src/lib/identus/fly-shared.ts`): the address is discovered *inside* the container with `ip -6 addr show`, falling back to `hostname -i`. The pinned image is `postgres:13-alpine` — it ships neither `iproute2` (so there is no `ip` command) nor an IPv6-capable `hostname -i` (BusyBox returns IPv4 only, and Fly's private network is IPv6-only). So `pghost` is always empty on this image, the probe fails closed, and every login is reported as rejected.
- Your Fly logs confirm Postgres itself is healthy: "database system is ready to accept connections", listening on `::` port 5432. Nothing is wrong with the database machine.
- Second symptom, same root cause: "No admin key stored for this stack." `provisionIdentusStack` runs the credential gate *before* the connection row with the admin key is written, so when the gate throws, `test5-identus` ends up with machines but no stored key — and the health step then can't authenticate to the agent.

Unconfirmed and deliberately not assumed: whether the role passwords themselves are correct. Once the probe has a real address it will either verify them or name the actual rejection.

## Plan

1. **Get the private address from Fly, not from inside the container.** The Machines API already returns each machine's 6PN address; pass it into the probe script as the host instead of discovering it in a shell that has no tooling for it. Keep an in-container fallback chain that works on Alpine (`$FLY_PRIVATE_IP`, then the machine's `.internal` DNS name) so the probe still works if the API field is missing.
2. **Keep the honesty rule.** The login must still be a password-checked connection over the private address — never loopback. If no address can be obtained from any source, the status stays "not verified" with that exact reason, as it does now.
3. **Make the reason precise.** Distinguish "no address available" from "address available, login rejected" in the reported detail, so the next failure can't be misread as a wrong password again.
4. **Store the admin key before the gate.** Write the Identus connection row (URLs + minted admin key) as soon as the app and machines exist, so a failed credential gate leaves a recoverable stack instead of a keyless one. Repairs then work without a re-provision.
5. **Repair the existing `test5-identus` stack in place**: press Fix agent DB after the change; it re-probes with the real address, resets the roles if the login is genuinely rejected, and only then recreates the cloud agent.
6. **Regression tests** in `src/lib/identus/fly-shared.test.ts`: the probe script must accept an injected host, must never fall back to `127.0.0.1`, and must not depend on the `ip` command.

## Technical notes

- Files: `src/lib/identus/fly-shared.ts` (`postgresProbeScript` gains a host parameter and an Alpine-safe fallback chain), `src/lib/identus/fly.server.ts` (read `private_ip` from the machine record, pass it to the probe; move the connection-row write ahead of `ensureVerifiedDbCredentials` in `provisionIdentusStack`), `src/lib/identus/fly-shared.test.ts`.
- No database migration. Passwords stay server-side; only the verified/not-verified flag and the reason reach the browser.
- Midnight code and machines are untouched.

## Verify

1. Fix agent DB on `test5-identus` → the card reads "remote password login verified" with a real address recorded, or names the specific rejection.
2. The cloud agent's boot log no longer ends in `password authentication failed`.
3. All four agent probes (system, DID registrar, issuance, connections) go green, and the timeline stops reporting a missing admin key.
