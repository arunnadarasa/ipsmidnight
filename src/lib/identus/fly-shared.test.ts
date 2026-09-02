import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AGENT_BOOT_MARKER,
  AGENT_INIT_EXEC,
  cloudAgentCredentialConfigMatches,
  cloudAgentDatabaseEnv,
  postgresInitSql,
  postgresProbeScript,
  postgresResetScript,
  resetAppRolesSql,
} from "./fly-shared";


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
    assert.equal(cloudAgentCredentialConfigMatches(env, "application-secret"), true);
    assert.equal(cloudAgentCredentialConfigMatches(env, "stale-secret"), false);
  });

  test("marks every new agent boot before starting the JVM", () => {
    const script = AGENT_INIT_EXEC.join(" ");
    assert.ok(script.includes(AGENT_BOOT_MARKER));
    assert.ok(script.indexOf(AGENT_BOOT_MARKER) < script.indexOf("identus-cloud-agent"));
  });

  test("creates and grants every application role with an escaped password", () => {
    const sql = postgresInitSql("safe'password");

    // The verifier scheme must be pinned before any role password is written.
    assert.ok(sql.indexOf(PG_PASSWORD_ENCRYPTION) === 0);
    for (const database of ["pollux", "connect", "agent", "node"]) {
      assert.ok(sql.includes(`CREATE ROLE "${database}-application-user" LOGIN PASSWORD 'safe''password'`));
      assert.ok(sql.includes(`\\connect ${database}`));
      assert.ok(sql.includes(`GRANT USAGE, CREATE ON SCHEMA public TO "${database}-application-user"`));
      assert.ok(sql.includes(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "${database}-application-user"`));
    }
  });

  test("pins the image host auth method to the verifier scheme", () => {
    assert.equal(POSTGRES_AUTH_ENV.POSTGRES_HOST_AUTH_METHOD, PG_HOST_AUTH_METHOD);
    assert.ok(POSTGRES_AUTH_ENV.POSTGRES_INITDB_ARGS.includes(`--auth-host=${PG_HOST_AUTH_METHOD}`));
    assert.ok(PG_PASSWORD_ENCRYPTION.includes(PG_HOST_AUTH_METHOD));
  });

  test("resets every application role in place with an escaped password", () => {
    const sql = resetAppRolesSql("safe'password");
    for (const role of ["pollux", "connect", "agent"]) {
      assert.ok(sql.includes(`ALTER ROLE "${role}-application-user" WITH LOGIN PASSWORD 'safe''password';`));
    }
  });

  test("probe script authenticates remotely, never over loopback", () => {
    const script = postgresProbeScript("safe'password");
    assert.ok(script.includes("ROLES="));
    assert.ok(script.includes("AUTH="));
    assert.ok(script.includes("HOST="));
    assert.ok(script.includes("VERIFIER="));
    assert.ok(script.includes("HBA="));
    // Loopback is trusted by initdb's rules, so it can never be the login path.
    assert.ok(!script.includes("127.0.0.1 -U"));
    for (const role of ["pollux", "connect", "agent"]) {
      assert.ok(script.includes(`-h "$pghost" -U ${role}-application-user -d ${role}`));
      assert.ok(script.includes(`AUTH_${role.toUpperCase()}=`));
    }
    // Shell-escaped, so the quote cannot break out of the assignment.
    assert.ok(script.includes(`PGPASSWORD='safe'\\''password'`));
  });

  test("reset script pins the verifier scheme before creating or altering roles", () => {
    const script = postgresResetScript("pw");
    // The SQL is shell-quoted for exec, so quotes appear in escaped form.
    assert.ok(script.indexOf(PG_PASSWORD_ENCRYPTION) < script.indexOf(`CREATE ROLE "pollux-application-user"`));
    assert.ok(script.includes(`ALTER ROLE "agent-application-user" WITH LOGIN PASSWORD`));
    assert.ok(script.includes("RESET="));
  });
});


