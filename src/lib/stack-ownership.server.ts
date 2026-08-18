/**
 * Fly app names are global across the whole platform, but the console lets a
 * user pick the prefix. Without a cross-tenant check, provisioning (or
 * "reconnecting") a prefix that someone else already owns would reconfigure and
 * restart *their* live machines with a freshly minted admin key.
 *
 * These guards run with the service-role client on purpose: the RLS-scoped
 * client can only see the caller's own rows, so it can never tell that a prefix
 * belongs to a different tenant.
 */

/** Throws when any other user already has a deployment or agent on this prefix. */
export async function assertPrefixNotOwnedByOthers(userId: string, appPrefix: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const [deployments, connections] = await Promise.all([
    supabaseAdmin.from("fly_deployments").select("user_id").eq("app_prefix", appPrefix),
    supabaseAdmin.from("agent_connections").select("user_id").eq("app_prefix", appPrefix),
  ]);

  if (deployments.error) throw new Error(`Could not verify stack ownership: ${deployments.error.message}`);
  if (connections.error) throw new Error(`Could not verify stack ownership: ${connections.error.message}`);

  const foreign = [...(deployments.data ?? []), ...(connections.data ?? [])].some(
    (row) => row.user_id !== userId,
  );

  if (foreign) {
    throw new Error(
      `The stack name "${appPrefix}" is already in use by another account. Pick a different prefix.`,
    );
  }
}

/**
 * Throws unless the caller already has a record for this prefix. Used by
 * adoption/repair paths, which push a new admin key onto running machines and
 * therefore must never run against infrastructure the caller does not own.
 */
export async function assertPrefixOwnedByCaller(
  supabase: {
    from: (table: string) => {
      select: (cols: string) => {
        eq: (col: string, value: string) => {
          eq: (col: string, value: string) => { limit: (n: number) => PromiseLike<{ data: unknown[] | null }> };
        };
      };
    };
  },
  userId: string,
  appPrefix: string,
) {
  const [deployment, connection] = await Promise.all([
    supabase.from("fly_deployments").select("id").eq("user_id", userId).eq("app_prefix", appPrefix).limit(1),
    supabase.from("agent_connections").select("id").eq("user_id", userId).eq("app_prefix", appPrefix).limit(1),
  ]);

  const owned = Boolean(deployment.data?.length) || Boolean(connection.data?.length);
  if (!owned) {
    throw new Error(
      `No stack named "${appPrefix}" belongs to this account, so it cannot be reconnected.`,
    );
  }
}
