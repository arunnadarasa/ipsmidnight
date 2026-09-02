# Fix the pollux-application-user password failure for good

## What the log proves

The agent reaches Postgres and is rejected at authentication:

```text
Caused by: org.postgresql.util.PSQLException: FATAL:
  password authentication failed for user "pollux-application-user"
AGENT_EXIT=1
```

So the role exists and the host resolves — only the password the agent sends does
not match the password stored in the database. Last turn's change aligned the
agent's usernames with the dedicated roles, which is why the error moved from
"role does not exist" to "password authentication failed".

Why the two passwords differ is **not yet confirmed**. The strongest candidate is
the credential derivation itself: passwords are derived with an HMAC whose key is
`IDENTUS_DB_SECRET`, falling back to `FLY_API_TOKEN`, falling back to the service
role key. The Fly token was re-saved during this debugging session, so any change
in that value silently changes every derived password, while the roles inside
Postgres keep the password from whichever boot initialised them. A second
candidate is that the Postgres init script did not re-run (it only executes
against an empty data directory). Both are invisible today, which is the real
defect.

## Plan

1. **Stop deriving database passwords from a rotatable secret.** Generate the
   superuser and application-role passwords once per stack, store them on the
   Identus deployment record in the backend, and read them back on every
   provision, repair, and machine-spec build. The same value then reaches the
   Postgres init script and the agent env forever, regardless of token rotation.
   Existing stacks with no stored passwords fall back to the current derivation
   once, and the derived values are written to the record so the next repair is
   stable.

2. **Verify the credentials against the live database instead of assuming.** Add
   a diagnostic that execs inside the Postgres machine and reports, in plain
   language: which `*-application-user` roles exist, and whether a connection as
   `pollux-application-user` with the configured password succeeds. Surface it in
   the Identus diagnostics drawer next to the boot log. This is the check that
   tells us the fix worked without waiting on a five-minute JVM boot.

3. **Make repair self-healing when the passwords disagree.** During the Identus
   repair, after Postgres is recreated, run the same credential probe; if the
   role password does not match, reset it in place (`ALTER ROLE … PASSWORD …`) for
   all three application roles rather than requiring another destroy cycle.

4. **Gate the agent on a usable database, not just a started machine.** Before
   restarting the cloud agent, wait until the app-role probe succeeds (bounded
   wait), so the agent does not spend its boot on a database that is still
   initialising or mid-reset.

5. **Regression tests.** Cover: stored passwords win over derived ones; the init
   SQL and the agent env receive the *same* app-role password; the reset path
   emits `ALTER ROLE` for all three roles.

## Then verify honestly

- Press **Fix agent DB** once, then read the new credential probe: roles present
  and `pollux-application-user` authenticating.
- Only after that, confirm the four agent health probes (system, DID registrar,
  issuance, connections) go green and the boot log records no new `AGENT_EXIT=1`.
- Anything not observed is reported as not checked. Midnight is untouched.

## Technical scope

- `src/lib/identus/db-creds.server.ts` — stored-first credentials with one-time
  derivation fallback and persistence.
- `src/lib/identus/fly.server.ts` — async credential lookup in `machineSpec`,
  password-reset and readiness gating in `repairIdentusStack`, credential probe
  via the machine `exec` endpoint.
- `src/lib/identus/fly-shared.ts` — SQL helpers for the probe and the role reset.
- `src/lib/stack.functions.ts` / `src/routes/app.deploy.tsx` — expose the probe
  result in diagnostics.
- Backend: one migration adding the password columns to the existing Identus
  deployment record table (values never returned to the browser).
