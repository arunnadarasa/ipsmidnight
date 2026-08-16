/** Constants shared by the Identus Fly provisioner and the console UI. */

export const IDENTUS_IMAGES = {
  postgres: "docker.io/postgres:16-alpine",
  prismNode: "docker.io/identus/prism-node:2.5.0",
  cloudAgent: "docker.io/identus/identus-cloud-agent:1.40.0",
} as const;

export const IDENTUS_DB = {
  user: "postgres",
  password: "postgres",
  databases: ["pollux", "connect", "agent", "node"] as const,
} as const;

/** Four separate databases keep the agent's schema migrations from colliding. */
export const POSTGRES_INIT_SQL = IDENTUS_DB.databases
  .map((db) => `CREATE DATABASE ${db};`)
  .join("\n");

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
