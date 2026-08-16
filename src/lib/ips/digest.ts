/**
 * Canonical JSON + SHA-256 digest. Used both in the browser (before saving /
 * anchoring) and on the server (before writing to the chain), so the digest
 * must be byte-stable: object keys are sorted, undefined dropped.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(walk);
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, val] of entries) out[k] = walk(val);
    return out;
  };
  return JSON.stringify(walk(value));
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(hash);
}

/** The IPS digest: sha256 over the canonical form of the FHIR bundle. */
export async function bundleDigest(bundle: unknown): Promise<string> {
  return sha256Hex(canonicalJson(bundle));
}

/**
 * The public commitment anchored on Midnight: sha256 over a domain separator +
 * the digest, so the same summary anchored for different purposes is unlinkable
 * across domains.
 */
export async function ipsCommitment(digest: string, salt: string): Promise<string> {
  return sha256Hex(`ips:anchor:v1|${digest}|${salt}`);
}

export function randomSaltHex(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

export function shortenId(value: string | null | undefined, head = 10, tail = 6): string {
  if (!value) return "—";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
