# Fix the Identus cloud-agent database role failure

## Root cause, now confirmed by the logs

The screenshots contain the actual exception, and it is not a wallet, memory, or networking problem:

```text
zio.FiberFailure: ERROR: role "pollux-application-user" does not exist
  at org.hyperledger.identus.pollux.sql.repository.Migrations$
  STATEMENT: ALTER DEFAULT PRIVILEGES IN SCHEMA public
             GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
             TO "pollux-application-user"
Main child exited normally with code: 1
```

The database connection itself is fine — the pool logs `Added connection … PgConnection` and `Start completed` immediately before the error. The agent then runs its first migration, which grants default privileges to a per-database application role, and that role does not exist in our Postgres.

Our Postgres init only creates the four databases. The upstream Identus init script also creates one application role per database (`pollux-application-user`, `connect-application-user`, `agent-application-user`) and applies the default-privileges grant inside each database. Because the roles are missing, every boot dies in the pollux migration — exactly the repeated exit code 1 and the earlier "resource acquisition" frames.

Two earlier guesses were wrong and should be reverted rather than layered over: the derived wallet seed and the extra `POSTGRES_*` connection group were not the problem. Upstream connects all three groups as the `postgres` superuser.

## Plan

1. **Create the application roles the migrations expect.**
   - Extend the Postgres init SQL so it creates one login role per database (`pollux`, `connect`, `agent`), idempotently, and applies the default-privileges grant inside each database.
   - Keep the four-database creation as-is; roles are added alongside it.

2. **Roll back the speculative agent settings.**
   - Remove the derived default-wallet seed and the redundant `POSTGRES_*` group so the agent config matches the upstream reference: three connection groups, all as the `postgres` user.
   - Keep the admin key, API-key settings, PRISM node address, service URLs, and the IPv6 JVM options.

3. **Reset the Identus database so init runs again.**
   - The init script only executes against an empty data directory, so reapplying config alone will not create the roles on the existing machine. The Identus Postgres machine must be recreated with a fresh data directory.
   - Only agent-internal state lives there; no patient summaries or issued credentials. Midnight is untouched.

4. **Make the failing step readable for good.**
   - Keep the agent's error text in the deployment timeline, and prefer the exception message line over a stack frame so a cause like this shows up in the console instead of only on Fly.
   - Hold later health probes as pending while a boot failure is active, instead of spinning on "Agent health: system".

5. **Repair only the Identus half.**
   - Provide an Identus-only recreate-and-repair action so a fix never restarts the healthy Midnight machines.

## Technical scope

- `src/lib/identus/fly-shared.ts`: init SQL gains the per-database application roles and grants.
- `src/lib/identus/fly.server.ts`: drop the wallet-seed derivation and `POSTGRES_*` group; add Postgres recreation to the Identus repair path.
- `src/lib/stack-steps.ts`: prefer the exception message and keep downstream probes pending on boot failure.
- `src/lib/stack.functions.ts` / `src/routes/app.deploy.tsx`: Identus-only repair action.
- No schema change in the app's own backend.

## Verification

1. After the Identus repair, the cloud agent records no new non-zero exit and no `role … does not exist` line.
2. All four agent probes (system, DID registrar, issuance, connections) turn green inside the grace period.
3. Publishing an issuer DID from the Identus page succeeds.
4. Midnight stays ready with an advancing block height throughout.
