# Fix Identus database authentication

## Confirmed diagnosis

The latest boot log shows `password authentication failed for user "pollux-application-user"` after the database machine was rebuilt. The current machine spec creates that dedicated role with `appRolePassword`, but configures all three Cloud Agent database connections as the `postgres` user with the separate superuser password. Identus 1.40 selects its dedicated `*-application-user` identities, so the resulting username/password pair does not match.

## Changes

1. **Align Cloud Agent credentials**
   - Configure Pollux as `pollux-application-user`, Connect as `connect-application-user`, and Agent as `agent-application-user`.
   - Give each connection the stable per-stack application-role password already used by the Postgres initialization script.
   - Keep the Prism node on the Postgres credentials it currently uses.

2. **Harden database initialization**
   - Preserve the Postgres 13 pin and per-stack deterministic secrets.
   - Ensure each application role has the schema, table, and sequence privileges/default privileges required by its own database migrations.
   - Escape/validate generated SQL values defensively even though the current derived password is hexadecimal.

3. **Add regression coverage**
   - Test that the generated Cloud Agent environment uses the three dedicated users and the application-role password, never the Postgres password.
   - Test that initialization SQL creates all required roles and grants table/sequence access in the correct databases.

4. **Validate the live repair path**
   - Confirm the project build and targeted tests pass.
   - Run **Fix agent DB** once so the corrected empty Postgres instance and Cloud Agent configuration are applied; Midnight remains untouched.
   - Poll readiness and inspect the persisted boot log. Mark success only if all four Identus health probes pass; otherwise report the next concrete JVM/database error without overstating verification.

## Technical scope

Files expected to change are limited to the Identus Fly machine specification, shared Postgres initialization helper, and focused tests. No IPS records, Midnight machines, or unrelated UI will be changed.
