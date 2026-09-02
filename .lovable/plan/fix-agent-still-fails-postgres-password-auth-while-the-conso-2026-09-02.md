# Fix: agent still fails Postgres password auth while the console says "verified"

## What the logs and code actually show

- The agent dies in HikariCP with `FATAL: password authentication failed for user "pollux-application-user"`, exit code 1. That means the role exists but its stored password does not verify for the connection the agent makes.
- `test4-identus` is a brand-new stack (credential row minted at provision time), so this is not credential drift from an older volume.
- The credential probe (`postgresProbeScript`) logs in with `psql -h 127.0.0.1`. A loopback login inside the Postgres container is the weakest possible test: the container's generated host rules commonly trust loopback, and the agent connects over the private network instead. So "Database credentials: agent login verified" can go green without any password ever being checked — that is the reason the console and the agent disagree.
- Provisioning has no credential gate at all (the repair path does). Postgres, PRISM node and the cloud agent are created back to back, and an existing Postgres machine is only updated, never rebuilt — its data directory persists, so the role-creation script never re-runs.

Unconfirmed: whether the underlying mismatch is a password-verifier format issue (role password stored in one hashing scheme while the host rule demands another) or role passwords set before the credential row settled. Step 1 below settles it with observed data instead of a guess.

## Plan

1. **Make the probe prove the real thing.** Extend the probe script to report facts, not just a boolean:
   - the container's host authentication rules (`pg_hba.conf` contents),
   - each application role's stored verifier type (SCRAM vs MD5 vs none), read from `pg_authid`,
   - a password login over the machine's private network address, not loopback, so no trusted-loopback rule can mask a failure.
   Only that remote, password-checked login may set the "verified" flag.

2. **Align verifier and host rule deterministically.** Set the Postgres image's host auth method and initdb auth explicitly, and set the password-encryption scheme in the same session that creates or resets the roles, so the stored verifier always matches the rule the agent's connection hits. Applied in both the init script and the in-place reset script.

3. **Gate provisioning, not just repair.** After the Postgres machine reports started, run the hardened probe; if the remote login is not verified, run the reset script (with retries while Postgres finishes starting) and re-probe. Only then create the PRISM node and the cloud agent. If it still cannot be verified, fail the step with the observed reason instead of booting an agent that will crash.

4. **Rebuild Postgres when its data directory is already initialised.** On provisioning, if a Postgres machine already exists, recreate it (its filesystem survives restarts, so the role script would otherwise never run again) or, when data must be kept, force the in-place role reset before continuing.

5. **Honest status in the UI.** The Identus card reports how the credential was proven: "remote password login verified", "not verified — <observed reason>", or "not checked". Never green from a probe that could not run or that used a trusted path. The boot-log drawer gains the observed host rules and verifier types so the next failure names itself.

6. **Regression tests** in `src/lib/identus/fly-shared.test.ts`: the probe script must not authenticate over loopback, must emit the verifier/host-rule markers, and the init/reset scripts must set the password-encryption scheme before creating or altering roles.

## Technical notes

- Files: `src/lib/identus/fly-shared.ts` (probe/reset/init scripts, `POSTGRES_HOST_AUTH_METHOD` + `POSTGRES_INITDB_ARGS` in the Postgres env), `src/lib/identus/fly.server.ts` (`identusDbProbe` parsing, `provisionIdentusStack` gate, Postgres recreate rule), `src/lib/stack.functions.ts` (expose the richer probe fields), `src/routes/app.deploy.tsx` (status wording), `src/lib/identus/fly-shared.test.ts`.
- No database migration is needed; the credential store stays as is.
- Passwords stay server-side: only the boolean/reason and role names reach the browser.
- After this ships, the live check is one press of **Fix agent DB** on `test4-identus`; the card must show the remote-login wording before the agent is expected to pass health.
