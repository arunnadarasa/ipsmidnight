import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const provisionFlyStack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string; region: string; orgSlug?: string }) => {
    const prefix = input.appPrefix.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{2,28}$/.test(prefix)) {
      throw new Error("App prefix must be 3-29 chars: lowercase letters, numbers, hyphens.");
    }
    return { ...input, appPrefix: prefix };
  })
  .handler(async ({ data, context }) => {
    const { provisionStack } = await import("./fly.server");
    const { supabase, userId } = context;

    let result;
    try {
      result = await provisionStack(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Provisioning failed";
      await supabase.from("fly_deployments").upsert(
        {
          user_id: userId,
          kind: "midnight",
          app_prefix: data.appPrefix,
          region: data.region,
          status: "error",
          last_error: message,
        },
        { onConflict: "user_id,app_prefix,kind" },
      );
      throw new Error(message);
    }

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

    await supabase.from("activity_log").insert({
      user_id: userId,
      kind: "fly.provisioned",
      summary: `Provisioned Midnight stack ${result.appName} in ${data.region}`,
      metadata: { appName: result.appName, machines: result.machines } as never,
    });

    return result;
  });

export const checkFlyStack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string }) => input)
  .handler(async ({ data, context }) => {
    const { machineStates, probeStack } = await import("./fly.server");
    const { stackUrls } = await import("./shared");
    const urls = stackUrls(`${data.appPrefix}-midnight`);

    const machines = await machineStates(urls.appName);
    const probes = await probeStack({ indexerUrl: urls.indexerUrl, proofUrl: urls.proofUrl });
    const ready = probes.indexer.ok && probes.proof.ok;

    await context.supabase
      .from("fly_deployments")
      .update({
        status: ready ? "ready" : machines.length ? "provisioning" : "unknown",
        machines: machines as never,
      })
      .eq("user_id", context.userId)
      .eq("kind", "midnight")
      .eq("app_prefix", data.appPrefix);

    return { ...urls, machines, probes, ready };
  });

export const destroyFlyStack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string }) => input)
  .handler(async ({ data, context }) => {
    const { destroyStack } = await import("./fly.server");
    await destroyStack(`${data.appPrefix}-midnight`);
    await context.supabase
      .from("fly_deployments")
      .delete()
      .eq("user_id", context.userId)
      .eq("kind", "midnight")
      .eq("app_prefix", data.appPrefix);
    await context.supabase.from("activity_log").insert({
      user_id: context.userId,
      kind: "fly.destroyed",
      summary: `Destroyed Midnight stack ${data.appPrefix}-midnight`,
      metadata: {} as never,
    });
    return { destroyed: true };
  });

/**
 * Indexer liveness probe for an anchor's contract. It records block height and
 * tx visibility only — it never promotes an anchor to "confirmed", because a
 * contract action on the indexer says nothing about which commitment it carried.
 * Confirmation comes from verifyAnchorMembership (runner ledger read).
 */
export const probeAnchorContract = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { anchorId: string }) => input)
  .handler(async ({ data, context }) => {
    const { probeContractOnChain } = await import("./fly.server");
    const { supabase, userId } = context;

    const { data: anchor, error } = await supabase
      .from("midnight_anchors")
      .select("id,contract_address,tx_hash,digest")
      .eq("id", data.anchorId)
      .single();
    if (error || !anchor) throw new Error("Anchor not found");
    if (!anchor.contract_address) throw new Error("This anchor has no contract address yet.");

    const { data: deployment } = await supabase
      .from("fly_deployments")
      .select("indexer_url")
      .eq("user_id", userId)
      .eq("kind", "midnight")
      .not("indexer_url", "is", null)
      .limit(1)
      .maybeSingle();
    if (!deployment?.indexer_url) throw new Error("No Fly indexer URL on record — provision the stack first.");

    const result = await probeContractOnChain({
      indexerUrl: deployment.indexer_url,
      contractAddress: anchor.contract_address,
      txHash: anchor.tx_hash,
    });

    await supabase
      .from("midnight_anchors")
      .update({
        block_height: result.blockHeight ?? null,
        last_error: result.ok ? null : result.detail,
      })
      .eq("id", anchor.id);

    await supabase.from("activity_log").insert({
      user_id: userId,
      kind: "anchor.probed",
      summary: result.ok
        ? `Contract for ${anchor.digest.slice(0, 12)}… seen on the indexer${result.blockHeight ? ` at block #${result.blockHeight}` : ""} (commitment not checked)`
        : `Contract for ${anchor.digest.slice(0, 12)}… not visible: ${result.detail}`,
      metadata: { anchorId: anchor.id } as never,
    });

    return result;
  });
