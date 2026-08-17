# Fix the Identus agent boot: Postgres major version mismatch

## What the log says

The agent now gets past the missing `pollux-application-user` role (that fix worked) and fails one migration later:

```text
Caused by: org.postgresql.util.PSQLException: ERROR: syntax error at or near "format" | Position: 162
```

## Confirmed cause

The pollux migration `V21__add_issuer_metadata.sql` (fetched from the upstream cloud-agent repo) creates:

```sql
CREATE TABLE public.issuer_credential_configuration (
    configuration_id VARCHAR(100) NOT NULL,
    issuer_id UUID NOT NULL,
    format VARCHAR(9) NOT NULL,
    ...
```

`format` is used as an **unquoted** column name. Upstream's own compose file pins `image: postgres:13`, where that parses fine. We provision `postgres:16-alpine`, and in Postgres 16 `FORMAT` is a reserved-in-context keyword (SQL/JSON `... FORMAT JSON`), so the bare `format` column definition is a syntax error at exactly this position. Nothing in our SQL or env is wrong — the database is simply newer than the migrations support.

## Fix

1. **Pin Postgres to the version upstream validates against** — change `IDENTUS_IMAGES.postgres` in `src/lib/identus/fly-shared.ts` to `docker.io/postgres:13-alpine`, with a comment explaining that Identus migrations use `format` as a column name and break on PG 15+.
2. **Recreate the Postgres machine so the new image and init script take effect.** The existing "Fix agent DB" action (`repairIdentusOnly`) already destroys and recreates the Identus Postgres machine; it now also picks up the new image. Also restart the cloud agent afterwards so Flyway reruns from a clean database.
3. **Guard against a repeat**: extend the boot-log error extraction so a `PSQLException ... Position:` line also reports the Flyway "Migrating schema … to version …" line that precedes it, giving the exact migration name in the timeline instead of just the syntax error.
4. **Timeline copy**: when the cause line matches a database migration failure, show a short hint ("agent database migration failed — use Fix agent DB") rather than the generic booting hint.

## Verification

After **Fix agent DB**, the timeline should clear `Agent health: system`, then DID registrar, issuance and connections. If it fails again, the new log line will name the failing migration file.

## Technical notes

- Files touched: `src/lib/identus/fly-shared.ts` (image pin), `src/lib/identus/fly.server.ts` (log/cause extraction), `src/lib/stack-steps.ts` and/or `src/components/deploy/StackTimeline.tsx` (hint text).
- No database schema changes, no changes to the Midnight stack — it is already healthy and untouched by this.
- The Identus Postgres machine has no Fly volume, so recreating it is non-destructive to anything we care about; the agent rebuilds all four schemas on first boot.
