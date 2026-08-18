import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isOver18 } from "@/lib/ips/age";

export const provisionIdentusAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string; region: string; label?: string; orgSlug?: string }) => {
    const prefix = input.appPrefix.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{2,28}$/.test(prefix)) {
      throw new Error("App prefix must be 3-29 chars: lowercase letters, numbers, hyphens.");
    }
    return { ...input, appPrefix: prefix };
  })
  .handler(async ({ data, context }) => {
    const { provisionIdentusStack } = await import("./fly.server");
    const { supabase, userId } = context;

    const { assertPrefixNotOwnedByOthers } = await import("@/lib/stack-ownership.server");
    await assertPrefixNotOwnedByOthers(userId, data.appPrefix);

    let result;
    try {
      result = await provisionIdentusStack({ appPrefix: data.appPrefix, region: data.region, ...(data.orgSlug ? { orgSlug: data.orgSlug } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Provisioning failed";
      await supabase.from("fly_deployments").upsert(
        {
          user_id: userId,
          kind: "identus",
          app_prefix: data.appPrefix,
          region: data.region,
          status: "error",
          last_error: message,
        },
        { onConflict: "user_id,app_prefix,kind" },
      );
      throw new Error(message);
    }

    const { recordIdentusDeployment } = await import("./fly.server");
    await recordIdentusDeployment(supabase, userId, { appPrefix: data.appPrefix, region: data.region, ...(data.label ? { label: data.label } : {}) }, result);

    await supabase.from("activity_log").insert({
      user_id: userId,
      kind: "identus.provisioned",
      summary: `Provisioned Identus Cloud Agent ${result.appName} in ${data.region}`,
      metadata: { appName: result.appName, machines: result.machines } as never,
    });

    return { appName: result.appName, agentUrl: result.agentUrl, didcommUrl: result.didcommUrl, machines: result.machines };
  });

export const checkIdentusAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string }) => input)
  .handler(async ({ data, context }) => {
    const { identusMachineStates } = await import("./fly.server");
    const { probeAgent } = await import("./cloud-agent.server");
    const { identusStackUrls } = await import("./fly-shared");
    const { supabase, userId } = context;

    const urls = identusStackUrls(`${data.appPrefix}-identus`);
    const machines = await identusMachineStates(urls.appName);

    const { data: conn } = await supabase
      .from("agent_connections")
      .select("id,api_key")
      .eq("user_id", userId)
      .eq("app_prefix", data.appPrefix)
      .maybeSingle();

    const health = conn?.api_key
      ? await probeAgent({ baseUrl: urls.agentUrl, apiKey: conn.api_key })
      : { probes: [], ready: false };

    const status = health.ready ? "ready" : machines.length ? "provisioning" : "unknown";

    await supabase
      .from("fly_deployments")
      .update({ status, machines: machines as never })
      .eq("user_id", userId)
      .eq("kind", "identus")
      .eq("app_prefix", data.appPrefix);

    if (conn?.id) {
      await supabase
        .from("agent_connections")
        .update({ readiness_status: health.ready ? "ready" : "provisioning" })
        .eq("id", conn.id);
    }

    return { ...urls, machines, ...health, status };
  });

export const diagnoseIdentusAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string }) => input)
  .handler(async ({ data }) => {
    const { identusDiagnostics } = await import("./fly.server");
    return { machines: await identusDiagnostics(`${data.appPrefix}-identus`) };
  });

export const repairIdentusEndpoints = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string }) => input)
  .handler(async ({ data, context }) => {
    const { repairAgentEndpoints } = await import("./fly.server");
    const { supabase, userId } = context;

    const { data: conn } = await supabase
      .from("agent_connections")
      .select("id,api_key")
      .eq("user_id", userId)
      .eq("app_prefix", data.appPrefix)
      .maybeSingle();
    if (!conn?.api_key) throw new Error("No stored admin key for this agent.");

    const { data: dep } = await supabase
      .from("fly_deployments")
      .select("region")
      .eq("user_id", userId)
      .eq("kind", "identus")
      .eq("app_prefix", data.appPrefix)
      .maybeSingle();

    const urls = await repairAgentEndpoints(`${data.appPrefix}-identus`, conn.api_key, dep?.region ?? "lhr");
    await supabase.from("agent_connections").update({ didcomm_url: urls.didcommUrl }).eq("id", conn.id);
    await supabase.from("activity_log").insert({
      user_id: userId,
      kind: "identus.repaired",
      summary: `Repaired DIDComm endpoint for ${urls.appName}`,
      metadata: { didcommUrl: urls.didcommUrl } as never,
    });
    return urls;
  });

export const destroyIdentusAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { appPrefix: string }) => input)
  .handler(async ({ data, context }) => {
    const { destroyIdentusStack } = await import("./fly.server");
    const { supabase, userId } = context;
    await destroyIdentusStack(`${data.appPrefix}-identus`);
    await supabase
      .from("fly_deployments")
      .delete()
      .eq("user_id", userId)
      .eq("kind", "identus")
      .eq("app_prefix", data.appPrefix);
    await supabase
      .from("agent_connections")
      .update({ readiness_status: "orphaned", is_active: false })
      .eq("user_id", userId)
      .eq("app_prefix", data.appPrefix);
    await supabase.from("activity_log").insert({
      user_id: userId,
      kind: "identus.destroyed",
      summary: `Destroyed Identus agent ${data.appPrefix}-identus`,
      metadata: {} as never,
    });
    return { destroyed: true };
  });

export const createAgentDid = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { agentId: string }) => input)
  .handler(async ({ data, context }) => {
    const { createIssuerDid } = await import("./cloud-agent.server");
    const { supabase, userId } = context;

    const { data: conn, error } = await supabase
      .from("agent_connections")
      .select("id,base_url,api_key,metadata")
      .eq("id", data.agentId)
      .single();
    if (error || !conn?.base_url || !conn.api_key) throw new Error("This agent has no hosted endpoint yet.");

    const did = await createIssuerDid({ baseUrl: conn.base_url, apiKey: conn.api_key });

    const meta = (conn.metadata ?? {}) as Record<string, unknown>;
    await supabase
      .from("agent_connections")
      .update({ metadata: { ...meta, issuerDid: did.did, longFormDid: did.longFormDid } as never })
      .eq("id", conn.id);

    await supabase.from("activity_log").insert({
      user_id: userId,
      kind: "did.published",
      summary: `Published issuer DID ${did.did.slice(0, 28)}…`,
      metadata: { did: did.did } as never,
    });

    return did;
  });

export const listIssuerDids = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { agentId: string }) => input)
  .handler(async ({ data, context }) => {
    const { assertionCapableDids } = await import("./cloud-agent.server");
    const { data: conn } = await context.supabase
      .from("agent_connections")
      .select("base_url,api_key")
      .eq("id", data.agentId)
      .maybeSingle();
    if (!conn?.base_url || !conn.api_key) return { usable: [], excluded: [] };
    return assertionCapableDids({ baseUrl: conn.base_url, apiKey: conn.api_key });
  });

export const issueHostedCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { agentId: string; bundleId: string; issuingDid: string }) => input)
  .handler(async ({ data, context }) => {
    const { issueConnectionlessCredential, getCredentialRecord } = await import("./cloud-agent.server");
    const { supabase, userId } = context;

    const { data: conn } = await supabase
      .from("agent_connections")
      .select("id,base_url,api_key")
      .eq("id", data.agentId)
      .maybeSingle();
    if (!conn?.base_url || !conn.api_key) throw new Error("This agent has no hosted endpoint yet.");

    const { data: bundle, error } = await supabase
      .from("ips_bundles")
      .select("id,title,digest,patient_name,bundle")
      .eq("id", data.bundleId)
      .single();
    if (error || !bundle) throw new Error("Summary not found");

    const patient = ((bundle.bundle as { entry?: { resource?: Record<string, unknown> }[] } | null)?.entry ?? [])
      .map((e) => e.resource)
      .find((r) => r?.["resourceType"] === "Patient");
    const dob = (patient?.["birthDate"] as string | undefined) ?? null;

    // Data minimisation: only the digest and (optionally) a derived age
    // assurance travel. Patient name, summary title and the raw birth date are
    // the standard re-identification pair and stay in the console.
    const claims: Record<string, unknown> = {
      summaryDigest: bundle.digest,
      credentialType: "InternationalPatientSummary",
      ...(dob ? { over18: isOver18(dob) } : {}),
    };

    const offer = await issueConnectionlessCredential({
      baseUrl: conn.base_url,
      apiKey: conn.api_key,
      issuingDid: data.issuingDid,
      claims,
    });

    // The invitation has just been created, so nothing has accepted it yet and
    // `credential` is null. Poll briefly: the row must only claim to hold a
    // credential once the protocol really reached CredentialSent/Issued.
    let jwt: string | null = null;
    let state = offer.state;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const record = await getCredentialRecord({
          baseUrl: conn.base_url,
          apiKey: conn.api_key,
          recordId: offer.recordId,
        });
        state = record.protocolState ?? state;
        if (record.credential) {
          jwt = record.credential;
          break;
        }
        if (/Failed|Rejected|Abandoned/i.test(state)) break;
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }

    const { error: insErr } = await supabase.from("credential_records").insert({
      user_id: userId,
      bundle_id: bundle.id,
      agent_id: conn.id,
      issuer_did: data.issuingDid,
      // The holder is whoever accepts the connectionless invitation, which has
      // not happened yet — leaving this null beats naming the issuer as its own
      // credential subject.
      subject_did: null,
      claims: claims as never,
      credential_jwt: jwt,
      state,
      simulated: false,
      record_id: offer.recordId,
      invitation_url: offer.invitationUrl,
    });
    if (insErr) throw new Error(insErr.message);

    await supabase.from("activity_log").insert({
      user_id: userId,
      kind: "credential.issued",
      summary: `Offered hosted IPS credential for "${bundle.title}"`,
      metadata: { bundleId: bundle.id, recordId: offer.recordId } as never,
    });

    return offer;
  });
