import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, ShieldQuestion, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { SectionHeading, Panel } from "@/components/SectionHeading";
import { TruncatedMono } from "@/components/MonoValue";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { bundleDigest, ipsCommitment } from "@/lib/ips/digest";
import { decodeCredential } from "@/lib/identus/agent";
import { validateIpsBundle } from "@/lib/ips/validate";

export const Route = createFileRoute("/app/verify")({
  head: () => ({
    meta: [
      { title: "Verify a summary — IPS Console" },
      {
        name: "description",
        content: "Check that a patient summary matches its credential claim and its on-chain Midnight commitment.",
      },
      { property: "og:title", content: "Verify a summary — IPS Console" },
      { property: "og:description", content: "Digest, credential, and ledger commitment checks in one pass." },
    ],
  }),
  component: VerifyWorkspace,
});

type Check = { label: string; ok: boolean | null; detail: string };

function VerifyWorkspace() {
  const [raw, setRaw] = useState("");
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);

  const creds = useQuery({
    queryKey: ["credentials_verify"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("credential_records")
        .select("id,credential_jwt,claims,issuer_did,subject_did,simulated,state")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const anchors = useQuery({
    queryKey: ["anchors_verify"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("midnight_anchors")
        .select("id,digest,commitment,salt,status,block_height,tx_hash,network")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const summary = useMemo(() => {
    if (!checks) return null;
    const decided = checks.filter((c) => c.ok !== null);
    return {
      passed: decided.filter((c) => c.ok).length,
      total: decided.length,
      allOk: decided.length > 0 && decided.every((c) => c.ok),
    };
  }, [checks]);

  async function runVerification() {
    setBusy(true);
    try {
      const parsed = JSON.parse(raw) as unknown;
      const validation = validateIpsBundle(parsed);
      const digest = await bundleDigest(parsed);

      const credential = creds.data?.find(
        (c) => (c.claims as { summaryDigest?: string } | null)?.summaryDigest === digest,
      );
      const anchor = anchors.data?.find((a) => a.digest === digest);

      // The commitment is only meaningful if it can be recomputed from the
      // pasted bundle: digest + persisted salt. Anchors written before the salt
      // was persisted cannot be checked and must not read as verified.
      let commitmentOk: boolean | null = null;
      let commitmentDetail = "No anchor on record for this digest.";
      const onLedger = anchor?.status === "anchored" || anchor?.status === "confirmed";
      if (anchor?.commitment && !anchor.salt) {
        commitmentOk = false;
        commitmentDetail =
          "This anchor predates salt persistence, so its commitment cannot be recomputed — re-anchor the summary.";
      } else if (anchor?.commitment && anchor.salt) {
        const recomputed = await ipsCommitment(digest, anchor.salt);
        if (recomputed !== anchor.commitment) {
          commitmentOk = false;
          commitmentDetail = "The stored commitment does not match this summary's digest and salt.";
        } else if (!onLedger) {
          commitmentOk = false;
          commitmentDetail = `Commitment recomputed, but the anchor is still ${anchor.status} — submit it on the Midnight page.`;
        } else {
          commitmentOk = true;
          commitmentDetail = `Commitment recomputed and anchored on ${anchor.network}${
            anchor.block_height ? ` at block #${anchor.block_height}` : ""
          }. Re-check membership on the Midnight page for a live ledger read.`;
        }
      }

      const decoded = credential?.credential_jwt ? decodeCredential(credential.credential_jwt) : null;
      const vc = decoded?.["vc"] as { credentialSubject?: Record<string, unknown> } | undefined;
      const subjectDigest = vc?.credentialSubject?.["summaryDigest"];
      const hasJwt = Boolean(credential?.credential_jwt);

      const blocking = validation.issues.filter((i) => i.severity === "error").length;
      setChecks([
        {
          label: "Structure conforms to the IPS profile",
          ok: validation.ok,
          detail: validation.ok
            ? `${validation.sections.filter((s) => s.present).length} sections recognised.`
            : `${blocking} blocking issue(s).`,
        },
        {
          label: "Digest recomputed from canonical JSON",
          ok: true,
          detail: digest,
        },
        {
          label: "A real credential was issued for this digest",
          ok: Boolean(credential) && hasJwt,
          detail: !credential
            ? "No issued credential matches this summary."
            : hasJwt
              ? `Issued by ${credential.issuer_did ?? "unknown issuer"} (state ${credential.state ?? "unknown"}).`
              : `An offer exists (state ${credential.state ?? "unknown"}) but no credential has been issued yet — nothing to verify.`,
        },
        {
          label: "Credential subject binds the same digest",
          ok: hasJwt ? subjectDigest === digest : null,
          detail: hasJwt
            ? subjectDigest === digest
              ? "credentialSubject.summaryDigest matches."
              : "The credential claims a different digest."
            : "Skipped — no credential to decode.",
        },
        {
          label: "Issuer signature verified",
          ok: hasJwt ? false : null,
          detail: !hasJwt
            ? "Skipped — no credential to decode."
            : credential?.simulated
              ? "This is a simulated credential: alg is \"none\" and the signature is a stub hash. It proves nothing."
              : "Not checked — the console decodes the JWT payload but performs no JWS verification, DID resolution, or status-list check.",
        },
        {
          label: "Midnight commitment anchored",
          ok: commitmentOk,
          detail: commitmentDetail,
        },
      ]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not parse that JSON");
      setChecks(null);
    } finally {
      setBusy(false);
    }
  }

  async function showCommitmentExample() {
    const digest = await bundleDigest({ demo: true });
    const commitment = await ipsCommitment(digest, "00".repeat(16));
    toast.info(`Commitment shape: ${commitment.slice(0, 24)}…`);
  }

  return (
    <div className="space-y-8">
      <SectionHeading
        eyebrow="Verification"
        title="Verify a patient summary"
        description="Paste a summary a clinician handed you. The console recomputes its digest, looks for a matching credential, and checks whether the commitment is anchored on Midnight."
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title="Summary to verify" subtitle="FHIR IPS bundle JSON">
          <div className="space-y-3">
            <Textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder='{"resourceType":"Bundle","type":"document", ...}'
              className="min-h-[280px] font-mono text-xs"
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void runVerification()} disabled={busy || raw.trim().length < 2}>
                <ShieldQuestion className="mr-1.5 h-4 w-4" /> Run checks
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void showCommitmentExample()}>
                What does a commitment look like?
              </Button>
            </div>
          </div>
        </Panel>

        <Panel
          title="Result"
          subtitle={summary ? `${summary.passed}/${summary.total} checks passed` : "Nothing verified yet"}
        >
          {checks ? (
            <ul className="space-y-2">
              {checks.map((c) => (
                <li key={c.label} className="rounded-xl border border-border bg-card/60 transition-colors hover:border-primary/40 px-3 py-2">
                  <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                    {c.ok === null ? (
                      <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : c.ok ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    ) : (
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm">{c.label}</p>
                      {/^[0-9a-f]{64}$/.test(c.detail) ? (
                        <TruncatedMono value={c.detail} head={16} tail={8} className="mt-1" />
                      ) : (
                        <p className="mt-0.5 text-xs text-muted-foreground">{c.detail}</p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              Paste a bundle and run the checks. Nothing you paste is stored.
            </p>
          )}
          {checks ? (
            <div className="mt-4 space-y-2">
              {checks.every((c) => c.ok !== false) ? (
                <Badge className="bg-success/15 text-success">Digest and anchor checks passed</Badge>
              ) : (
                <Badge variant="outline" className="text-destructive">
                  Not verifiable — see the failed checks
                </Badge>
              )}
              <p className="text-xs text-muted-foreground">
                No cryptographic signature is verified anywhere in this console: credentials are decoded, not
                validated. Treat a pass as "the digest and the ledger anchor line up", never as proof of issuer
                identity.
              </p>
            </div>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}
