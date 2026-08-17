import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const PREFIX_RE = /^[a-z][a-z0-9-]{2,28}$/;

function validatePrefix<T extends { appPrefix: string; region: string; label?: string; orgSlug?: string }>(input: T): T {
  const prefix = input.appPrefix.trim().toLowerCase();
  if (!PREFIX_RE.test(prefix)) {
    throw new Error("App prefix must be 3-29 chars: lowercase letters, numbers, hyphens.");
  }
  return { ...input, appPrefix: prefix };
}

/**
 * Provisions both the Identus Cloud Agent and the Midnight stack under one
 * app prefix. The two stacks stay physically separate Fly apps
 * (`<prefix>-identus` and `<prefix>-midnight`); this function launches them as
 * a single logical unit. A failure on one half is recorded but never rolls
 * back the half that succeeded — the UI offers a "retry failed half" path.
 */
export const provisionFullStack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string; region: string; label?: string; orgSlug?: string }) =>
    validatePrefix(input),
  )
  .handler(async ({ data, context }) => {
    const { provisionIdentusStack, recordIdentusDeployment } = await import("@/lib/identus/fly.server");
    const { provisionStack } = await import("@/lib/midnight/fly.server");
    const { supabase, userId } = context;

    const label = data.label?.trim() ? data.label.trim() : undefined;

    // --- Identus half ---
    let identusResult: { ok: true; result: Awaited<ReturnType<typeof provisionIdentusStack>> } | { ok: false; error: string };
    try {
      const result = await provisionIdentusStack({ appPrefix: data.appPrefix, region: data.region, ...(data.orgSlug ? { orgSlug: data.orgSlug } : {}) });
      await recordIdentusDeployment(supabase, userId, { appPrefix: data.appPrefix, region: data.region, ...(label ? { label } : {}) }, result);
      identusResult = { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Identus provisioning failed";
      await supabase.from("fly_deployments").upsert(
        { user_id: userId, kind: "identus", app_prefix: data.appPrefix, region: data.region, status: "error", last_error: message },
        { onConflict: "user_id,app_prefix,kind" },
      );
      identusResult = { ok: false, error: message };
    }

    // --- Midnight half ---
    let midnightResult: { ok: true; result: Awaited<ReturnType<typeof provisionStack>> } | { ok: false; error: string };
    try {
      const result = await provisionStack({ appPrefix: data.appPrefix, region: data.region, ...(data.orgSlug ? { orgSlug: data.orgSlug } : {}) });
      await supabase.from("fly_deployments").upsert(
        {
          user_id: userId,
          kind: "midnight",
          app_prefix: data.appPrefix,
          region: data.region,
          status: "provisioning",
          last_error: null,
          indexer_url: result.indexerUrl,
          indexer_ws_url: result.indexerWsUrl,
          proof_url: result.proofUrl,
          node_url: result.nodeUrl,
          machines: result.machines as never,
        },
        { onConflict: "user_id,app_prefix,kind" },
      );
      midnightResult = { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Midnight provisioning failed";
      await supabase.from("fly_deployments").upsert(
        { user_id: userId, kind: "midnight", app_prefix: data.appPrefix, region: data.region, status: "error", last_error: message },
        { onConflict: "user_id,app_prefix,kind" },
      );
      midnightResult = { ok: false, error: message };
    }

    await supabase.from("activity_log").insert({
      user_id: userId,
      kind: "stack.provisioned",
      summary: `Provisioned IPS stack ${data.appPrefix} in ${data.region} — Identus ${identusResult.ok ? "ok" : "failed"}, Midnight ${midnightResult.ok ? "ok" : "failed"}`,
      metadata: {
        appPrefix: data.appPrefix,
        region: data.region,
        identus: identusResult.ok ? { appName: identusResult.result.appName } : { error: identusResult.error },
        midnight: midnightResult.ok ? { appName: midnightResult.result.appName } : { error: midnightResult.error },
      } as never,
    });

    if (!identusResult.ok && !midnightResult.ok) {
      throw new Error(`Identus: ${identusResult.error} | Midnight: ${midnightResult.error}`);
    }

    return {
      identus: identusResult.ok
        ? { ok: true, appName: identusResult.result.appName, agentUrl: identusResult.result.agentUrl, didcommUrl: identusResult.result.didcommUrl, machines: identusResult.result.machines }
        : { ok: false, error: identusResult.error },
      midnight: midnightResult.ok
        ? { ok: true, appName: midnightResult.result.appName, indexerUrl: midnightResult.result.indexerUrl, proofUrl: midnightResult.result.proofUrl, machines: midnightResult.result.machines }
        : { ok: false, error: midnightResult.error },
      appPrefix: data.appPrefix,
      region: data.region,
    };
  });

/** Combined readiness check for both halves of an IPS stack. */
export const checkFullStack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string }) => input)
  .handler(async ({ data, context }) => {
    const { identusMachineStates, agentLogTail } = await import("@/lib/identus/fly.server");
    const { probeAgent } = await import("@/lib/identus/cloud-agent.server");
    const { identusStackUrls } = await import("@/lib/identus/fly-shared");
    const { machineStates, probeStack } = await import("@/lib/midnight/fly.server");
    const { stackUrls } = await import("@/lib/midnight/shared");
    const { supabase, userId } = context;

    const identusUrls = identusStackUrls(`${data.appPrefix}-identus`);
    const midnightUrls = stackUrls(`${data.appPrefix}-midnight`);

    // Identus half
    const { data: conn } = await supabase
      .from("agent_connections")
      .select("id,api_key")
      .eq("user_id", userId)
      .eq("app_prefix", data.appPrefix)
      .maybeSingle();
    const identusMachines = await identusMachineStates(identusUrls.appName);
    const identusHealth = conn?.api_key
      ? await probeAgent({ baseUrl: identusUrls.agentUrl, apiKey: conn.api_key })
      : { probes: [], ready: false };
    const identusStatus = identusHealth.ready ? "ready" : identusMachines.length ? "provisioning" : "unknown";
    // Only pull logs when something is wrong — that is the one moment the
    // stack trace matters, and it keeps the happy-path check fast.
    const identusLog = identusHealth.ready ? null : await agentLogTail(identusUrls.appName);
    await supabase
      .from("fly_deployments")
      .update({ status: identusStatus, machines: identusMachines as never })
      .eq("user_id", userId)
      .eq("kind", "identus")
      .eq("app_prefix", data.appPrefix);
    if (conn?.id) {
      await supabase
        .from("agent_connections")
        .update({ readiness_status: identusHealth.ready ? "ready" : "provisioning" })
        .eq("id", conn.id);
    }

    // Midnight half
    const midnightMachines = await machineStates(midnightUrls.appName);
    const midnightProbes = await probeStack({ indexerUrl: midnightUrls.indexerUrl, proofUrl: midnightUrls.proofUrl });
    const midnightReady = midnightProbes.indexer.ok && midnightProbes.proof.ok;
    const midnightStatus = midnightReady ? "ready" : midnightMachines.length ? "provisioning" : "unknown";
    await supabase
      .from("fly_deployments")
      .update({ status: midnightStatus, machines: midnightMachines as never })
      .eq("user_id", userId)
      .eq("kind", "midnight")
      .eq("app_prefix", data.appPrefix);

    return {
      identus: {
        urls: identusUrls,
        machines: identusMachines,
        health: identusHealth,
        status: identusStatus,
        ready: identusHealth.ready,
        logTail: identusLog,
      },
      midnight: { urls: midnightUrls, machines: midnightMachines, probes: midnightProbes, status: midnightStatus, ready: midnightReady },
      allReady: identusHealth.ready && midnightReady,
      appPrefix: data.appPrefix,
    };
  });

/** Tears down both halves of an IPS stack. 404s on Fly are treated as already-gone. */
export const destroyFullStack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string }) => input)
  .handler(async ({ data, context }) => {
    const { destroyIdentusStack } = await import("@/lib/identus/fly.server");
    const { destroyStack } = await import("@/lib/midnight/fly.server");
    const { supabase, userId } = context;

    await Promise.allSettled([
      destroyIdentusStack(`${data.appPrefix}-identus`),
      destroyStack(`${data.appPrefix}-midnight`),
    ]);

    await supabase.from("fly_deployments").delete().eq("user_id", userId).eq("app_prefix", data.appPrefix);
    await supabase
      .from("agent_connections")
      .update({ readiness_status: "orphaned", is_active: false })
      .eq("user_id", userId)
      .eq("app_prefix", data.appPrefix);

    await supabase.from("activity_log").insert({
      user_id: userId,
      kind: "stack.destroyed",
      summary: `Destroyed IPS stack ${data.appPrefix} (Identus + Midnight)`,
      metadata: { appPrefix: data.appPrefix } as never,
    });

    return { destroyed: true };
  });

/**
 * Re-applies the corrected machine config to an already-provisioned stack and
 * restarts every machine. Fixes stacks created before process-group metadata
 * and the IPv6 node RPC binding existed — data is preserved.
 */
export const repairFullStack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string; region?: string }) => input)
  .handler(async ({ data, context }) => {
    const { repairIdentusStack } = await import("@/lib/identus/fly.server");
    const { repairMidnightStack } = await import("@/lib/midnight/fly.server");
    const { supabase, userId } = context;

    const { data: rows } = await supabase
      .from("fly_deployments")
      .select("kind,region")
      .eq("user_id", userId)
      .eq("app_prefix", data.appPrefix);
    const region = data.region ?? rows?.[0]?.region ?? "lhr";

    const { data: conn } = await supabase
      .from("agent_connections")
      .select("api_key")
      .eq("user_id", userId)
      .eq("app_prefix", data.appPrefix)
      .maybeSingle();

    const results = await Promise.allSettled([
      conn?.api_key
        ? repairIdentusStack(`${data.appPrefix}-identus`, conn.api_key, region)
        : Promise.reject(new Error("No stored admin key for this Identus stack — reprovision instead.")),
      repairMidnightStack(`${data.appPrefix}-midnight`, region),
    ]);

    const identus = results[0];
    const midnight = results[1];
    const errorOf = (r: PromiseSettledResult<unknown>) =>
      r.status === "rejected" ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : null;

    await supabase
      .from("fly_deployments")
      .update({ status: "provisioning", last_error: errorOf(identus) })
      .eq("user_id", userId)
      .eq("kind", "identus")
      .eq("app_prefix", data.appPrefix);
    await supabase
      .from("fly_deployments")
      .update({ status: "provisioning", last_error: errorOf(midnight) })
      .eq("user_id", userId)
      .eq("kind", "midnight")
      .eq("app_prefix", data.appPrefix);

    await supabase.from("activity_log").insert({
      user_id: userId,
      kind: "stack.repaired",
      summary: `Repaired stack config for ${data.appPrefix} (process-group DNS + node RPC)`,
      metadata: { appPrefix: data.appPrefix, identus: errorOf(identus), midnight: errorOf(midnight) } as never,
    });

    if (identus.status === "rejected" && midnight.status === "rejected") {
      throw new Error(`${errorOf(identus)} | ${errorOf(midnight)}`);
    }
    return {
      identus: identus.status === "fulfilled" ? { ok: true } : { ok: false, error: errorOf(identus) },
      midnight: midnight.status === "fulfilled" ? { ok: true } : { ok: false, error: errorOf(midnight) },
    };
  });

/**
 * Repairs only the Identus half: reapplies the cloud-agent/PRISM config and
 * recreates the Identus Postgres machine so its init script runs again and
 * creates the `<db>-application-user` roles the agent's migrations require.
 * The Midnight machines are never touched, so a healthy chain keeps producing
 * blocks while the agent is fixed.
 */
export const repairIdentusOnly = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string; region?: string }) => input)
  .handler(async ({ data, context }) => {
    const { repairIdentusStack } = await import("@/lib/identus/fly.server");
    const { supabase, userId } = context;

    const { data: rows } = await supabase
      .from("fly_deployments")
      .select("region")
      .eq("user_id", userId)
      .eq("kind", "identus")
      .eq("app_prefix", data.appPrefix);
    const region = data.region ?? rows?.[0]?.region ?? "lhr";

    const { data: conn } = await supabase
      .from("agent_connections")
      .select("api_key")
      .eq("user_id", userId)
      .eq("app_prefix", data.appPrefix)
      .maybeSingle();
    if (!conn?.api_key) throw new Error("No stored admin key for this Identus stack — reprovision instead.");

    await repairIdentusStack(`${data.appPrefix}-identus`, conn.api_key, region);

    await supabase
      .from("fly_deployments")
      .update({ status: "provisioning", last_error: null })
      .eq("user_id", userId)
      .eq("kind", "identus")
      .eq("app_prefix", data.appPrefix);

    await supabase.from("activity_log").insert({
      user_id: userId,
      kind: "stack.repaired",
      summary: `Repaired Identus agent for ${data.appPrefix} (database app roles recreated)`,
      metadata: { appPrefix: data.appPrefix, scope: "identus" } as never,
    });

    return { ok: true };
  });




/** Lists the existing IPS stack deployments for the signed-in user (both kinds). */
export const listStacks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("fly_deployments")
      .select("id,kind,app_prefix,region,status,last_error,agent_url,indexer_url,proof_url,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    // group rows by app_prefix into combined stacks
    const map = new Map<string, {
      appPrefix: string;
      region: string;
      created_at: string;
      identus?: { status: string; last_error: string | null; agent_url: string | null };
      midnight?: { status: string; last_error: string | null; indexer_url: string | null; proof_url: string | null };
    }>();
    for (const row of data ?? []) {
      const entry = map.get(row.app_prefix) ?? { appPrefix: row.app_prefix, region: row.region, created_at: row.created_at };
      if (entry.created_at < row.created_at) entry.created_at = row.created_at;
      if (row.kind === "identus") {
        entry.identus = { status: row.status, last_error: row.last_error, agent_url: row.agent_url };
      } else if (row.kind === "midnight") {
        entry.midnight = { status: row.status, last_error: row.last_error, indexer_url: row.indexer_url, proof_url: row.proof_url };
      }
      map.set(row.app_prefix, entry);
    }
    return [...map.values()];
  });
