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

  test("resets every application role in place with an escaped password", () => {
    const sql = resetAppRolesSql("safe'password");
    for (const role of ["pollux", "connect", "agent"]) {
      assert.ok(sql.includes(`ALTER ROLE "${role}-application-user" WITH LOGIN PASSWORD 'safe''password';`));
    }
  });

  test("probe script logs in over TCP as the agent's own role", () => {
    const script = postgresProbeScript("safe'password");
    assert.ok(script.includes("ROLES="));
    assert.ok(script.includes("AUTH="));
    assert.ok(script.includes("-h 127.0.0.1 -U pollux-application-user"));
    // Shell-escaped, so the quote cannot break out of the assignment.
    assert.ok(script.includes(`PGPASSWORD='safe'\\''password'`));
  });

  test("reset script creates missing roles before altering them", () => {
    const script = postgresResetScript("pw");
    assert.ok(script.includes(`CREATE ROLE "pollux-application-user" LOGIN PASSWORD 'pw'`));
    assert.ok(script.includes(`ALTER ROLE "agent-application-user" WITH LOGIN PASSWORD 'pw';`));
    assert.ok(script.includes("RESET="));
  });
});
