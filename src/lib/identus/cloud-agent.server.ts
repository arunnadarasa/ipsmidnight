/** Thin REST client for a Hyperledger Identus Cloud Agent. */

function base(url: string) {
  // Direct Fly deploys serve at root; strip any APISIX-style prefix.
  return url.replace(/\/+$/, "").replace(/\/cloud-agent$/, "");
}

async function agentFetch<T>(
  input: { baseUrl: string; apiKey: string },
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${base(input.baseUrl)}${path}`, {
    ...init,
    headers: {
      apikey: input.apiKey,
      "x-admin-api-key": input.apiKey,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Agent ${init?.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export type ProbeResult = { name: string; ok: boolean; status: number | null; detail: string };

async function probe(
  input: { baseUrl: string; apiKey: string },
  name: string,
  path: string,
): Promise<ProbeResult> {
  try {
    const res = await fetch(`${base(input.baseUrl)}${path}`, {
      headers: { apikey: input.apiKey, "x-admin-api-key": input.apiKey },
      // Fly rejects readiness waits longer than a minute; keep each probe short.
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.text()).slice(0, 160);
    return { name, ok: res.ok, status: res.status, detail: body || res.statusText };
  } catch (err) {
    return { name, ok: false, status: null, detail: err instanceof Error ? err.message : "unreachable" };
  }
}

/** All four probes must pass before the agent is usable for issuance. */
export async function probeAgent(input: { baseUrl: string; apiKey: string }) {
  const probes = [
    await probe(input, "system", "/_system/health"),
    await probe(input, "did-registrar", "/did-registrar/dids?offset=0&limit=1"),
    await probe(input, "issuance", "/issue-credentials/records?offset=0&limit=1"),
    await probe(input, "connections", "/connections?offset=0&limit=1"),
  ];
  return { probes, ready: probes.every((p) => p.ok) };
}

type DidOperation = { longFormDid?: string; did?: string; scheduledOperation?: { didRef?: string } };

/** Creates a did:prism with an assertionMethod key, then publishes it. */
export async function createIssuerDid(input: { baseUrl: string; apiKey: string }) {
  const created = await agentFetch<DidOperation>(input, "/did-registrar/dids", {
    method: "POST",
    body: JSON.stringify({
      documentTemplate: {
        publicKeys: [
          { id: "auth-1", purpose: "authentication", curve: "secp256k1" },
          { id: "assert-1", purpose: "assertionMethod", curve: "secp256k1" },
        ],
        services: [],
      },
    }),
  });
  const longForm = created.longFormDid ?? created.did;
  if (!longForm) throw new Error("Agent did not return a DID");
  const shortForm = longForm.split(":").slice(0, 3).join(":");

  const published = await agentFetch<{ scheduledOperation?: { didRef?: string } }>(
    input,
    `/did-registrar/dids/${encodeURIComponent(shortForm)}/publications`,
    { method: "POST" },
  );

  return {
    longFormDid: longForm,
    did: shortForm,
    publicationRef: published.scheduledOperation?.didRef ?? null,
  };
}

export async function listAgentDids(input: { baseUrl: string; apiKey: string }) {
  const res = await agentFetch<{ contents?: { did: string; status: string }[] }>(
    input,
    "/did-registrar/dids?offset=0&limit=50",
  );
  return res.contents ?? [];
}

/** Only a published DID carrying an assertionMethod key can sign an offer. */
export async function assertionCapableDids(input: { baseUrl: string; apiKey: string }) {
  const dids = await listAgentDids(input);
  const usable: string[] = [];
  const excluded: { did: string; reason: string }[] = [];
  for (const d of dids) {
    if (d.status !== "PUBLISHED") {
      excluded.push({ did: d.did, reason: `status is ${d.status}` });
      continue;
    }
    try {
      const doc = await agentFetch<{ didDocument?: { assertionMethod?: unknown[] } }>(
        input,
        `/dids/${encodeURIComponent(d.did)}`,
      );
      if (doc.didDocument?.assertionMethod?.length) usable.push(d.did);
      else excluded.push({ did: d.did, reason: "no assertionMethod key" });
    } catch (err) {
      excluded.push({ did: d.did, reason: err instanceof Error ? err.message : "resolve failed" });
    }
  }
  return { usable, excluded };
}

/** Connectionless offer: no established DIDComm connection required. */
export async function issueConnectionlessCredential(input: {
  baseUrl: string;
  apiKey: string;
  issuingDid: string;
  claims: Record<string, unknown>;
}) {
  const record = await agentFetch<{
    recordId: string;
    protocolState?: string;
    invitation?: { invitationUrl?: string };
    invitationUrl?: string;
  }>(input, "/issue-credentials/credential-offers/invitation", {
    method: "POST",
    body: JSON.stringify({
      claims: input.claims,
      credentialFormat: "JWT",
      issuingDID: input.issuingDid,
      automaticIssuance: true,
      goalCode: "issue-vc",
      goal: "Issue an International Patient Summary credential",
    }),
  });

  return {
    recordId: record.recordId,
    state: record.protocolState ?? "OfferSent",
    invitationUrl: record.invitation?.invitationUrl ?? record.invitationUrl ?? null,
  };
}

export async function getCredentialRecord(input: { baseUrl: string; apiKey: string; recordId: string }) {
  return agentFetch<{ recordId: string; protocolState: string; credential?: string }>(
    input,
    `/issue-credentials/records/${input.recordId}`,
  );
}
