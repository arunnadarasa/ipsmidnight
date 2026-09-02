import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cloudAgentDatabaseEnv, postgresInitSql } from "./fly-shared";

describe("Identus database configuration", () => {
  test("uses each dedicated application role with the application password", () => {
    const env = cloudAgentDatabaseEnv({ superuser: "super-secret", appRole: "application-secret" });

    assert.deepEqual(env, {
      POLLUX_DB_USER: "pollux-application-user",
      POLLUX_DB_PASSWORD: "application-secret",
      CONNECT_DB_USER: "connect-application-user",
      CONNECT_DB_PASSWORD: "application-secret",
      AGENT_DB_USER: "agent-application-user",
      AGENT_DB_PASSWORD: "application-secret",
    });
    assert.ok(!Object.values(env).includes("super-secret"));
  });

  test("creates and grants every application role with an escaped password", () => {
    const sql = postgresInitSql("safe'password");

    for (const database of ["pollux", "connect", "agent", "node"]) {
      assert.ok(sql.includes(`CREATE ROLE "${database}-application-user" LOGIN PASSWORD 'safe''password'`));
      assert.ok(sql.includes(`\\connect ${database}`));
      assert.ok(sql.includes(`GRANT USAGE, CREATE ON SCHEMA public TO "${database}-application-user"`));
      assert.ok(sql.includes(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "${database}-application-user"`));
    }
  });
});