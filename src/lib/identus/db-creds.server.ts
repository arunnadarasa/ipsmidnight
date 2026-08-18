import { createHmac } from "crypto";

/**
 * Per-stack Postgres credentials.
 *
 * Every provisioned Identus stack used to share one hardcoded password, so any
 * machine that could reach another tenant's 6PN hostname could read their
 * identity data. Passwords are now derived per Fly app with an HMAC over a
 * server-only secret: unique per tenant, never sent to the browser, and stable
 * across repairs (a random password would lock the console out of an already
 * initialised Postgres volume).
 */

function derivationSecret(): string {
  const secret =
    process.env['IDENTUS_DB_SECRET'] ??
    process.env['FLY_API_TOKEN'] ??
    process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!secret) {
    throw new Error("No server secret available to derive database credentials.");
  }
  return secret;
}

function derive(appName: string, purpose: string): string {
  return createHmac("sha256", derivationSecret())
    .update(`identus:${purpose}:${appName}`)
    .digest("hex")
    .slice(0, 32);
}

export type IdentusDbCreds = {
  user: string;
  password: string;
  /** Password for the per-database `<db>-application-user` login roles. */
  appRolePassword: string;
};

export function identusDbCreds(appName: string): IdentusDbCreds {
  return {
    user: "postgres",
    password: derive(appName, "superuser"),
    appRolePassword: derive(appName, "app-role"),
  };
}
