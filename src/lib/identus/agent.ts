import { sha256Hex, toHex } from "@/lib/ips/digest";

export type AgentMode = "simulated" | "cloud-agent";

/** did:prism-shaped identifier derived locally for simulated agents. */
export async function simulatedDid(seed: string): Promise<string> {
  const hash = await sha256Hex(`did:prism:${seed}`);
  return `did:prism:${hash}`;
}

export function randomSeed(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** Compact, unsigned JWT-shaped envelope used in simulated mode. */
export async function simulatedCredential(input: {
  issuerDid: string;
  subjectDid: string;
  claims: Record<string, unknown>;
}): Promise<string> {
  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const header = encode({ alg: "none", typ: "JWT" });
  const payload = encode({
    iss: input.issuerDid,
    sub: input.subjectDid,
    nbf: Math.floor(Date.now() / 1000),
    vc: {
      "@context": ["https://www.w3.org/2018/credentials/v1"],
      type: ["VerifiableCredential", "InternationalPatientSummaryCredential"],
      credentialSubject: { id: input.subjectDid, ...input.claims },
    },
  });
  const signature = (await sha256Hex(`${header}.${payload}`)).slice(0, 43);
  return `${header}.${payload}.${signature}`;
}

export function decodeCredential(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Probe a real Identus Cloud Agent. Fly deploys serve at root, no /cloud-agent prefix. */
export function agentBaseUrl(baseUrl: string, mode: AgentMode): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return mode === "cloud-agent" ? trimmed.replace(/\/cloud-agent$/, "") : trimmed;
}
