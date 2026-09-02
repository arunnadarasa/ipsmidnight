import { createHmac, randomBytes } from "crypto";

/**
 * Per-stack Postgres credentials.
 *
 * Passwords used to be derived with an HMAC over whichever server secret was
 * available (`IDENTUS_DB_SECRET`, else `FLY_API_TOKEN`, else the service role
 * key). That is unstable by construction: re-saving or rotating the Fly token
 * silently changes every derived password, while the roles inside an already
 * initialised Postgres keep the password from the boot that created them — the
 * exact `password authentication failed for user "pollux-application-user"`
 * failure.
 *
 * Passwords are therefore generated once per Fly app and stored server-side
 * (service-role only, never returned to the browser). Stacks provisioned before
 * this change fall back to the old derivation once, and that value is persisted
 * so every later repair sees the same credentials.
 */

const TABLE = "identus_db_credentials" as const;

export type IdentusDbCreds = {
  user: string;
  password: string;
  /** Password for the per-database `<db>-application-user` login roles. */
  appRolePassword: string;
};

function derivationSecret(): string | null {
  return (
    process.env['IDENTUS_DB_SECRET'] ??
    process.env['FLY_API_TOKEN'] ??
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ??
    null
  );
}

/** Legacy derivation, kept only to adopt stacks provisioned before the store. */
export function deriveIdentusDbCreds(appName: string): IdentusDbCreds | null {
  const secret = derivationSecret();
  if (!secret) return null;
  const derive = (purpose: string) =>
    createHmac("sha256", secret).update(`identus:${purpose}:${appName}`).digest("hex").slice(0, 32);
  return {
    user: "postgres",
    password: derive("superuser"),
    appRolePassword: derive("app-role"),
  };
}

function freshPassword() {
  return randomBytes(16).toString("hex");
}

/**
 * Stored-first credentials for `appName`. Creates and persists them on first
 * use. Never send the result to the browser.
 */
export async function identusDbCreds(appName: string): Promise<IdentusDbCreds> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data } = await supabaseAdmin
    .from(TABLE)
    .select("superuser_password, app_role_password")
    .eq("app_name", appName)
    .maybeSingle();

  if (data?.superuser_password && data.app_role_password) {
    return {
      user: "postgres",
      password: data.superuser_password,
      appRolePassword: data.app_role_password,
    };
  }

  // Adopt the legacy derived values when they exist, so an already initialised
  // Postgres keeps working; otherwise mint fresh random ones.
  const seed = deriveIdentusDbCreds(appName) ?? {
    user: "postgres",
    password: freshPassword(),
    appRolePassword: freshPassword(),
  };

  await supabaseAdmin.from(TABLE).upsert(
    {
      app_name: appName,
      superuser_password: seed.password,
      app_role_password: seed.appRolePassword,
    },
    { onConflict: "app_name" },
  );

  return seed;
}
