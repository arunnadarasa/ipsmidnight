import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { RUNNER } from "./shared";

function validPrefix(appPrefix: string) {
  const prefix = appPrefix.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{2,28}$/.test(prefix)) throw new Error("Invalid app prefix.");
  return prefix;
}

export const getRunnerStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string }) => ({ appPrefix: validPrefix(input.appPrefix) }))
  .handler(async ({ data, context }) => {
    const { runnerStatus } = await import("./runner.server");
    const status = await runnerStatus(data.appPrefix);

    const { data: contract } = await context.supabase
      .from("midnight_contracts")
      .select("address, deploy_tx, created_at")
      .eq("user_id", context.userId)
      .eq("app_prefix", data.appPrefix)
      .eq("contract_name", "IpsAnchorRegistry")
      .maybeSingle();

    return { ...status, contract: contract ?? null };
  });

/**
 * Creates the runner machine and installs the toolchain. The compiled contract
 * and scripts are delivered through a short-lived signed Storage URL so the
 * private bucket never has to be exposed.
 */
export const prepareRunnerMachine = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string; region: string }) => ({
    appPrefix: validPrefix(input.appPrefix),
    region: input.region,
  }))
  .handler(async ({ data, context }) => {
    const { prepareRunner } = await import("./runner.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: signed, error } = await supabaseAdmin.storage
      .from(RUNNER.bucket)
      .createSignedUrl(RUNNER.object, 60 * 30);
    if (error || !signed?.signedUrl) {
      throw new Error(`Could not sign the contract artifact URL: ${error?.message ?? "unknown error"}`);
    }

    const result = await prepareRunner({ ...data, bundleUrl: signed.signedUrl });

    await context.supabase.from("activity_log").insert({
      user_id: context.userId,
      kind: "midnight.runner.prepare",
      summary: `Preparing the Midnight contract runner on ${data.appPrefix}-midnight`,
      metadata: { jobId: result.jobId, machine: result.machine } as never,
    });
    return result;
  });

export const deployAnchorContract = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string }) => ({ appPrefix: validPrefix(input.appPrefix) }))
  .handler(async ({ data, context }) => {
    const { startDeployJob } = await import("./runner.server");
    const result = await startDeployJob(data.appPrefix);
    await context.supabase.from("activity_log").insert({
      user_id: context.userId,
      kind: "midnight.contract.deploy",
      summary: `Deploying IpsAnchorRegistry from ${result.appName}`,
      metadata: { jobId: result.jobId } as never,
    });
    return result;
  });

export const anchorQueuedSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string; anchorId: string }) => ({
    appPrefix: validPrefix(input.appPrefix),
    anchorId: input.anchorId,
  }))
  .handler(async ({ data, context }) => {
    const { startAnchorJob } = await import("./runner.server");
    const { supabase, userId } = context;

    // RLS already scopes this, but the explicit user filter keeps the failure
    // mode obvious if the row belongs to someone else.
    const { data: anchor, error } = await supabase
      .from("midnight_anchors")
      .select("id, commitment")
      .eq("id", data.anchorId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !anchor) throw new Error("That anchor no longer exists.");
    if (!anchor.commitment) throw new Error("That anchor has no commitment to submit.");

    const { data: contract } = await supabase
      .from("midnight_contracts")
      .select("address")
      .eq("user_id", userId)
      .eq("app_prefix", data.appPrefix)
      .eq("contract_name", "IpsAnchorRegistry")
      .maybeSingle();
    if (!contract?.address) throw new Error("Deploy the anchor contract before submitting anchors.");

    const result = await startAnchorJob({
      appPrefix: data.appPrefix,
      commitment: anchor.commitment.replace(/^0x/, ""),
      contractAddress: contract.address,
      anchorId: anchor.id,
    });

    await supabase
      .from("midnight_anchors")
      .update({ status: "proving", last_error: null, contract_address: contract.address })
      .eq("id", anchor.id);

    return result;
  });

/**
 * Polls a detached job and, when it finished successfully, persists what it
 * produced: a contract address for deploys, a tx id / block height for anchors.
 */
export const pollRunnerJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string; jobId: string; anchorId?: string }) => ({
    appPrefix: validPrefix(input.appPrefix),
    jobId: input.jobId,
    anchorId: input.anchorId,
  }))
  .handler(async ({ data, context }) => {
    const { pollJob } = await import("./runner.server");
    const { supabase, userId } = context;
    const job = await pollJob(data.appPrefix, data.jobId);

    if (job.kind === "deploy" && job.result?.ok && job.result.address) {
      await supabase.from("midnight_contracts").upsert(
        {
          user_id: userId,
          app_prefix: data.appPrefix,
          contract_name: "IpsAnchorRegistry",
          address: job.result.address,
          deploy_tx: job.result.deployTx ?? null,
          network: "undeployed",
        },
        { onConflict: "user_id,app_prefix,contract_name" },
      );
    }

    if (job.kind === "anchor" && data.anchorId && job.result) {
      if (job.result.ok) {
        await supabase
          .from("midnight_anchors")
          .update({
            status: "anchored",
            tx_hash: job.result.txId ?? null,
            block_height: job.result.blockHeight ?? null,
            last_error: null,
          })
          .eq("id", data.anchorId)
          .eq("user_id", userId);
      } else {
        await supabase
          .from("midnight_anchors")
          .update({ status: "error", last_error: job.result.error })
          .eq("id", data.anchorId)
          .eq("user_id", userId);
      }
    }

    return job;
  });
