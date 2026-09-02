/** Constants shared by the Identus Fly provisioner and the console UI. */

export const IDENTUS_IMAGES = {
  // Postgres 13 — the version upstream's own compose pins. The agent's pollux
  // migration V21 declares an unquoted `format` column, and from PG 15/16 on
  // FORMAT is reserved in that position (SQL/JSON `… FORMAT JSON`), so the
  // migration dies with `syntax error at or near "format"`.
  postgres: "docker.io/postgres:13-alpine",
  prismNode: "docker.io/identus/prism-node:2.5.0",
  cloudAgent: "docker.io/identus/identus-cloud-agent:1.40.0",
} as const;


export const IDENTUS_DB = {
  user: "postgres",
  databases: ["pollux", "connect", "agent", "node"] as const,
} as const;

export type IdentusDatabasePasswords = {
  superuser: string;
  appRole: string;
};

/** Database identities expected by Identus Cloud Agent 1.40. */
export function cloudAgentDatabaseEnv(passwords: IdentusDatabasePasswords) {
  return {
    POLLUX_DB_USER: "pollux-application-user",
    POLLUX_DB_PASSWORD: passwords.appRole,
    CONNECT_DB_USER: "connect-application-user",
    CONNECT_DB_PASSWORD: passwords.appRole,
    AGENT_DB_USER: "agent-application-user",
    AGENT_DB_PASSWORD: passwords.appRole,
  } as const;
}

/**
 * Confirms the active machine spec carries the same application-role password
 * that was proven against Postgres. Keep this server-side: callers expose only
 * the boolean result, never either credential value.
 */
export function cloudAgentCredentialConfigMatches(
  env: Record<string, string> | undefined,
  appRolePassword: string,
) {
  if (!env) return false;
  const expected = cloudAgentDatabaseEnv({ superuser: "", appRole: appRolePassword });
  return (
    env.POLLUX_DB_USER === expected.POLLUX_DB_USER &&
    env.POLLUX_DB_PASSWORD === expected.POLLUX_DB_PASSWORD &&
    env.CONNECT_DB_USER === expected.CONNECT_DB_USER &&
    env.CONNECT_DB_PASSWORD === expected.CONNECT_DB_PASSWORD &&
    env.AGENT_DB_USER === expected.AGENT_DB_USER &&
    env.AGENT_DB_PASSWORD === expected.AGENT_DB_PASSWORD
  );
}

function sqlLiteral(value: string) {
  return value.replaceAll("'", "''");
}

/** Shell-single-quote escape for values interpolated into an exec script. */
function shellLiteral(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The three login roles the Cloud Agent authenticates as. */
export const APP_ROLES = ["pollux-application-user", "connect-application-user", "agent-application-user"] as const;

/** Database each application role must be able to log into. */
export const APP_ROLE_DATABASES = {
  "pollux-application-user": "pollux",
  "connect-application-user": "connect",
  "agent-application-user": "agent",
} as const;

/**
 * Resets every application role's password in place.
 *
 * The Postgres init script only runs against an empty data directory, so a
 * password mismatch on an existing volume cannot be fixed by re-applying config.
 * `ALTER ROLE` makes the repair path idempotent without destroying data.
 */
export function resetAppRolesSql(appRolePassword: string) {
  const password = sqlLiteral(appRolePassword);
  return APP_ROLES.map((role) => `ALTER ROLE "${role}" WITH LOGIN PASSWORD '${password}';`).join("\n");
}

/** Markers the probe/reset scripts print, parsed back by the server. */
export const DB_PROBE_MARKERS = {
  roles: "ROLES=",
  auth: "AUTH=",
  reset: "RESET=",
} as const;

/**
 * Script run inside the Postgres machine: lists the application roles that
 * exist, then attempts a real TCP login as `pollux-application-user` with the
 * password the agent is configured with. This is what turns "we think the
 * credentials match" into an observed fact.
 */
export function postgresProbeScript(appRolePassword: string) {
  const pw = shellLiteral(appRolePassword);
  return [
    `roles=$(psql -U postgres -d postgres -tAc "select string_agg(rolname, ',' order by rolname) from pg_roles where rolname like '%-application-user'" 2>&1 | tr -d '[:space:]')`,
    `echo "${DB_PROBE_MARKERS.roles}$roles"`,
    `auth=$(PGPASSWORD=${pw} psql -h 127.0.0.1 -U pollux-application-user -d pollux -tAc "select 1" 2>&1 | tr -d '[:space:]')`,
    `echo "${DB_PROBE_MARKERS.auth}$auth"`,
  ].join("; ");
}

/** Script that resets the roles' passwords (creating any missing role first). */
export function postgresResetScript(appRolePassword: string) {
  const create = APP_ROLES.map(
    (role) =>
      `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE "${role}" LOGIN PASSWORD '${sqlLiteral(appRolePassword)}'; END IF; END $do$;`,
  ).join("\n");
  const grants = Object.entries(APP_ROLE_DATABASES)
    .map(
      ([role, db]) =>
        `\\connect ${db}\nGRANT USAGE, CREATE ON SCHEMA public TO "${role}";\nGRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}";\nGRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "${role}";`,
    )
    .join("\n");
  const sql = [create, resetAppRolesSql(appRolePassword), grants].join("\n");
  return `printf '%s' ${shellLiteral(sql)} | psql -U postgres -d postgres -v ON_ERROR_STOP=0 2>&1 | tail -n 5; echo "${DB_PROBE_MARKERS.reset}$?"`;
}


/**
 * Four separate databases keep the agent's schema migrations from colliding.
 *
 * Each database also needs its own `<db>-application-user` login role: the very
 * first statement of the agent's Flyway migration is
 * `ALTER DEFAULT PRIVILEGES … TO "<db>-application-user"`, which aborts the boot
 * with `role "pollux-application-user" does not exist` when the role is absent.
 * The grant must be applied inside each database, hence the `\connect` hops.
 * Runs only while the Postgres data directory is empty.
 */
export function postgresInitSql(appRolePassword: string) {
  const password = sqlLiteral(appRolePassword);
  return [
    ...IDENTUS_DB.databases.map(
      (db) => `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${db}-application-user') THEN
    CREATE ROLE "${db}-application-user" LOGIN PASSWORD '${password}';
  END IF;
END $$;`,
    ),
    ...IDENTUS_DB.databases.map((db) => `CREATE DATABASE ${db};`),
    ...IDENTUS_DB.databases.flatMap((db) => [
      `\\connect ${db}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${db}-application-user";`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "${db}-application-user";`,
      `GRANT USAGE, CREATE ON SCHEMA public TO "${db}-application-user";`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${db}-application-user";`,
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "${db}-application-user";`,
    ]),
  ].join("\n");
}


/** The JVM must prefer IPv6 — Fly's private network is 6PN only. */
export const JAVA_TOOL_OPTIONS =
  "-Djava.net.preferIPv6Addresses=true -Djava.net.preferIPv4Stack=false -XX:MaxRAMPercentage=70";

export type IdentusStackUrls = {
  appName: string;
  agentUrl: string;
  didcommUrl: string;
};

export function identusStackUrls(appName: string): IdentusStackUrls {
  return {
    appName,
    // Direct Fly deploys serve the agent at the root — no /cloud-agent prefix.
    agentUrl: `https://${appName}.fly.dev`,
    didcommUrl: `https://${appName}.fly.dev:8090`,
  };
}

export const AGENT_MACHINES = ["identus-postgres", "identus-prism-node", "identus-cloud-agent"] as const;

/** Image entrypoint of `identus/identus-cloud-agent` (sbt-native-packager layout). */
export const AGENT_ENTRYPOINT = "/opt/docker/bin/identus-cloud-agent";

/**
 * Where the boot wrapper tees the agent's stdout/stderr inside the machine.
 *
 * This lives on a mounted volume, not in `/tmp`: the boot that actually fails is
 * the one we need to read, and a machine-local path is wiped by the restart that
 * follows the crash — leaving the console with "the machine hasn't started" and
 * no error text at all.
 */
export const AGENT_LOG_DIR = "/var/log/identus";
export const AGENT_LOG_PATH = `${AGENT_LOG_DIR}/agent-boot.log`;
/** Previous boots, kept so a crash-loop still shows the first failing boot. */
export const AGENT_LOG_HISTORY = [`${AGENT_LOG_PATH}.1`, `${AGENT_LOG_PATH}.2`] as const;

/** Fly volume that carries {@link AGENT_LOG_DIR}. */
export const AGENT_LOG_VOLUME = "identus_agent_log";

/**
 * Seconds the machine idles after a non-zero exit before handing the exit code
 * back to Fly. `exec` only works against a running machine, so without this hold
 * every log read races the restart and returns nothing.
 */
export const AGENT_CRASH_HOLD_SECONDS = 600;

/** Marker the wrapper writes into the log when the JVM exits. */
export const AGENT_EXIT_MARKER = "AGENT_EXIT=";
export const AGENT_BOOT_MARKER = "AGENT_BOOT=";

/**
 * Boot wrapper for the cloud agent. Fly's Machines API exposes no log endpoint,
 * so the agent's own stdout is captured to a file we can read back over
 * `machines/:id/exec` — that file is the only way to see the JVM exception that
 * kills the process. `tail -F` keeps the live Fly log stream intact and the
 * explicit `exit $c` preserves the real exit code (a pipe would mask it).
 *
 * On a non-zero exit the wrapper holds the machine open for
 * {@link AGENT_CRASH_HOLD_SECONDS} so the log is readable, then exits with the
 * real code so Fly's restart policy and the exit events stay truthful.
 */
export const AGENT_INIT_EXEC = [
  "/bin/sh",
  "-c",
  `mkdir -p ${AGENT_LOG_DIR}; ` +
    `if [ -f ${AGENT_LOG_HISTORY[0]} ]; then mv -f ${AGENT_LOG_HISTORY[0]} ${AGENT_LOG_HISTORY[1]}; fi; ` +
    `if [ -f ${AGENT_LOG_PATH} ]; then mv -f ${AGENT_LOG_PATH} ${AGENT_LOG_HISTORY[0]}; fi; ` +
    `: > ${AGENT_LOG_PATH}; echo "${AGENT_BOOT_MARKER}$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> ${AGENT_LOG_PATH}; tail -n +1 -F ${AGENT_LOG_PATH} & ` +
    `${AGENT_ENTRYPOINT} >> ${AGENT_LOG_PATH} 2>&1; c=$?; ` +
    `echo "${AGENT_EXIT_MARKER}$c" >> ${AGENT_LOG_PATH}; ` +
    `if [ "$c" != "0" ]; then sleep ${AGENT_CRASH_HOLD_SECONDS}; else sleep 1; fi; exit $c`,
] as const;

