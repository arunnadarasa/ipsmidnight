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
  password: "postgres",
  databases: ["pollux", "connect", "agent", "node"] as const,
} as const;

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
export const POSTGRES_INIT_SQL = [
  ...IDENTUS_DB.databases.map(
    (db) => `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${db}-application-user') THEN
    CREATE ROLE "${db}-application-user" LOGIN PASSWORD 'password';
  END IF;
END $$;`,
  ),
  ...IDENTUS_DB.databases.map((db) => `CREATE DATABASE ${db};`),
  ...IDENTUS_DB.databases.flatMap((db) => [
    `\\connect ${db}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${db}-application-user";`,
    `GRANT USAGE, CREATE ON SCHEMA public TO "${db}-application-user";`,
  ]),
].join("\n");


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

/** Where the boot wrapper tees the agent's stdout/stderr inside the machine. */
export const AGENT_LOG_PATH = "/tmp/agent-boot.log";

/**
 * Boot wrapper for the cloud agent. Fly's Machines API exposes no log endpoint,
 * so the agent's own stdout is captured to a file we can read back over
 * `machines/:id/exec` — that file is the only way to see the JVM exception that
 * kills the process. `tail -F` keeps the live Fly log stream intact and the
 * explicit `exit $c` preserves the real exit code (a pipe would mask it).
 */
export const AGENT_INIT_EXEC = [
  "/bin/sh",
  "-c",
  `touch ${AGENT_LOG_PATH}; tail -n +1 -F ${AGENT_LOG_PATH} & ` +
    `${AGENT_ENTRYPOINT} >> ${AGENT_LOG_PATH} 2>&1; c=$?; sleep 1; exit $c`,
] as const;
