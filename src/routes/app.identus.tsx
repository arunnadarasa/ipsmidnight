import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BadgeCheck, Fingerprint, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { SectionHeading, Panel } from "@/components/SectionHeading";
import { StatusDot, TruncatedMono } from "@/components/MonoValue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { randomSeed, simulatedCredential, simulatedDid } from "@/lib/identus/agent";
import { patientDisplayName, findPatient } from "@/lib/ips/validate";
import type { FhirBundle } from "@/lib/ips/types";

export const Route = createFileRoute("/app/identus")({
  head: () => ({
    meta: [
      { title: "Identus credentials — IPS Console" },
      {
        name: "description",
        content: "Manage decentralised identifiers and issue verifiable credentials over patient summaries.",
      },
      { property: "og:title", content: "Identus credentials — IPS Console" },
      { property: "og:description", content: "DIDs and verifiable credentials for International Patient Summaries." },
    ],
  }),
  component: IdentusConsole,
});

function IdentusConsole() {
  const qc = useQueryClient();
  const [label, setLabel] = useState("Local issuer");
  const [selectedBundle, setSelectedBundle] = useState<string>("");

  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("agent_connections")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const bundles = useQuery({
    queryKey: ["ips_bundles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ips_bundles")
        .select("id,title,bundle,digest,patient_name")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const creds = useQuery({
    queryKey: ["credentials"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("credential_records")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const activeAgent = agents.data?.find((a) => a.is_active) ?? agents.data?.[0] ?? null;

  const createAgent = useMutation({
    mutationFn: async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new Error("Not signed in");
      const seed = randomSeed();
      const issuerDid = await simulatedDid(seed);
      const { error } = await supabase.from("agent_connections").insert({
        user_id: uid,
        label,
        mode: "simulated",
        readiness_status: "ready",
        is_active: !agents.data?.length,
        metadata: { issuerDid, seed } as never,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Issuer agent created");
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const activate = useMutation({
    mutationFn: async (id: string) => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new Error("Not signed in");
      await supabase.from("agent_connections").update({ is_active: false }).eq("user_id", uid);
      const { error } = await supabase.from("agent_connections").update({ is_active: true }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["agents"] }),
  });

  const issue = useMutation({
    mutationFn: async () => {
      const bundle = bundles.data?.find((b) => b.id === selectedBundle);
      if (!bundle) throw new Error("Choose a patient summary first");
      if (!activeAgent) throw new Error("Create an issuer agent first");
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new Error("Not signed in");

      const meta = (activeAgent.metadata ?? {}) as { issuerDid?: string };
      const issuerDid = meta.issuerDid ?? (await simulatedDid(activeAgent.id));
      const subjectDid = await simulatedDid(`${bundle.id}:subject`);
      const patient = findPatient(bundle.bundle as unknown as FhirBundle);
      const dob = (patient?.["birthDate"] as string | undefined) ?? null;

      const claims = {
        summaryDigest: bundle.digest,
        summaryTitle: bundle.title,
        patientName: bundle.patient_name ?? patientDisplayName(patient),
        ...(dob ? { dob } : {}),
        credentialType: "InternationalPatientSummary",
      };
      const jwt = await simulatedCredential({ issuerDid, subjectDid, claims });

      const { error } = await supabase.from("credential_records").insert({
        user_id: uid,
        bundle_id: bundle.id,
        agent_id: activeAgent.id,
        issuer_did: issuerDid,
        subject_did: subjectDid,
        claims: claims as never,
        credential_jwt: jwt,
        state: "CredentialIssued",
        simulated: true,
      });
      if (error) throw error;

      await supabase.from("activity_log").insert({
        user_id: uid,
        kind: "credential.issued",
        summary: `Issued IPS credential for "${bundle.title}"`,
        metadata: { bundleId: bundle.id } as never,
      });
    },
    onSuccess: () => {
      toast.success("Credential issued");
      void qc.invalidateQueries({ queryKey: ["credentials"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-8">
      <SectionHeading
        eyebrow="Identus"
        title="Identifiers & credentials"
        description="Issue verifiable credentials over a patient summary. Simulated agents derive did:prism-shaped identifiers locally; a hosted Cloud Agent can be attached later."
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Issuer agents" subtitle="Simulated mode — no external service">
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="label">Agent label</Label>
                <Input id="label" value={label} onChange={(e) => setLabel(e.target.value)} />
              </div>
              <Button onClick={() => createAgent.mutate()} disabled={createAgent.isPending}>
                <Plus className="mr-1.5 h-4 w-4" /> Create
              </Button>
            </div>

            {agents.data?.length ? (
              <ul className="space-y-2">
                {agents.data.map((a) => {
                  const meta = (a.metadata ?? {}) as { issuerDid?: string };
                  return (
                    <li
                      key={a.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-md border border-border bg-card/40 px-3 py-2"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusDot status={a.readiness_status === "ready" ? "ok" : "pending"} />
                          <span className="truncate text-sm">{a.label}</span>
                          <Badge variant="secondary" className="text-[11px]">
                            {a.mode}
                          </Badge>
                          {a.is_active ? <Badge className="bg-primary/15 text-primary">active</Badge> : null}
                        </div>
                        <TruncatedMono value={meta.issuerDid ?? null} label="issuer DID" head={18} tail={8} />
                      </div>
                      {a.is_active ? null : (
                        <Button size="sm" variant="outline" onClick={() => activate.mutate(a.id)}>
                          Set active
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No agents yet.</p>
            )}
          </div>
        </Panel>

        <Panel title="Issue a credential" subtitle="Binds a summary digest to a subject DID">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Patient summary</Label>
              <Select value={selectedBundle} onValueChange={setSelectedBundle}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a saved summary" />
                </SelectTrigger>
                <SelectContent>
                  {bundles.data?.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              The credential carries the summary digest and a date-of-birth claim — never the clinical content
              itself. That keeps it usable for the age proof on the verification page.
            </p>
            <Button onClick={() => issue.mutate()} disabled={issue.isPending || !selectedBundle}>
              <BadgeCheck className="mr-1.5 h-4 w-4" /> Issue credential
            </Button>
          </div>
        </Panel>
      </div>

      <Panel title="Credentials" subtitle="Issued records">
        {creds.data?.length ? (
          <ul className="space-y-2">
            {creds.data.map((c) => (
              <li key={c.id} className="space-y-1 rounded-md border border-border bg-card/40 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Fingerprint className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <Badge variant="secondary" className="text-[11px]">
                    {c.state}
                  </Badge>
                  {c.simulated ? <Badge variant="outline">simulated</Badge> : null}
                  <span className="min-w-0 truncate text-sm">
                    {(c.claims as { summaryTitle?: string } | null)?.summaryTitle ?? "IPS credential"}
                  </span>
                </div>
                <TruncatedMono value={c.issuer_did} label="issuer" head={18} tail={8} />
                <TruncatedMono value={c.subject_did} label="subject" head={18} tail={8} />
                <TruncatedMono value={c.credential_jwt} label="jwt" head={16} tail={8} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No credentials issued yet.</p>
        )}
      </Panel>
    </div>
  );
}
