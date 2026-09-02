import { describe, expect, test } from "bun:test";
import { cloudAgentDatabaseEnv, postgresInitSql } from "./fly-shared";

describe("Identus database configuration", () => {
  test("uses each dedicated application role with the application password", () => {
    const env = cloudAgentDatabaseEnv({ superuser: "super-secret", appRole: "application-secret" });

    expect(env).toEqual({
      POLLUX_DB_USER: "pollux-application-user",
      POLLUX_DB_PASSWORD: "application-secret",
      CONNECT_DB_USER: "connect-application-user",
      CONNECT_DB_PASSWORD: "application-secret",
      AGENT_DB_USER: "agent-application-user",
      AGENT_DB_PASSWORD: "application-secret",
    });
    expect(Object.values(env)).not.toContain("super-secret");
  });

  test("creates and grants every application role with an escaped password", () => {
    const sql = postgresInitSql("safe'password");

    for (const database of ["pollux", "connect", "agent", "node"]) {
      expect(sql).toContain(`CREATE ROLE "${database}-application-user" LOGIN PASSWORD 'safe''password'`);
      expect(sql).toContain(`\\connect ${database}`);
      expect(sql).toContain(`GRANT USAGE, CREATE ON SCHEMA public TO "${database}-application-user"`);
      expect(sql).toContain(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "${database}-application-user"`);
    }
  });
});