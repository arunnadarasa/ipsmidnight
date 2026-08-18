import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { BadgeCheck, Fingerprint, KeyRound, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { SectionHeading, Panel } from "@/components/SectionHeading";
import { StatusDot, TruncatedMono } from "@/components/MonoValue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { randomSeed, simulatedCredential, simulatedDid } from "@/lib/identus/agent";
import { FlyAgentPanel } from "@/components/identus/FlyAgentPanel";
import { createAgentDid, issueHostedCredential, listIssuerDids } from "@/lib/identus/fly.functions";
import { findPatient } from "@/lib/ips/validate";
import { isOver18 } from "@/lib/ips/age";
import type { FhirBundle } from "@/lib/ips/types";

export const Route = createFileRoute("/app/identus")({
  head: () => ({
    meta: [
      { title: "Identus credentials — IPS Console" },
      {
        name: "description",
        content:
          "Manage decentralised identifiers and issue verifiable credentials over patient summaries, simulated or on a Fly.io-hosted Identus Cloud Agent.",
      },
      { property: "og:title", content: "Identus credentials — IPS Console" },
      { property: "og:description", content: "DIDs and verifiable credentials for International Patient Summaries." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: IdentusConsole,
});

function IdentusConsole() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"simulated" | "fly">("simulated");
  const [label, setLabel] = useState("Local issuer");
  const [selectedBundle, setSelectedBundle] = useState<string>("");
  const [issuingDid, setIssuingDid] = useState<string>("");

  const makeDid = useServerFn(createAgentDid);
  const issueHosted = useServerFn(issueHostedCredential);
  const fetchDids = useServerFn(listIssuerDids);

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
  const flyAgent = agents.data?.find((a) => a.mode === "fly" && a.readiness_status !== "orphaned") ?? null;

  const dids = useQuery({
    queryKey: ["issuer_dids", flyAgent?.id],
    enabled: Boolean(flyAgent?.id) && mode === "fly",
    queryFn: () => fetchDids({ data: { agentId: flyAgent!.id } }),
  });

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

  const publishDid = useMutation({
    mutationFn: () => makeDid({ data: { agentId: flyAgent!.id } }),
    onSuccess: (r) => {
      toast.success("Issuer DID published");
      setIssuingDid(r.did);
      void qc.invalidateQueries({ queryKey: ["issuer_dids"] });
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const issue = useMutation({
    mutationFn: async () => {
      const bundle = bundles.data?.find((b) => b.id === selectedBundle);
      if (!bundle) throw new Error("Choose a patient summary first");

      if (mode === "fly") {
        if (!flyAgent) throw new Error("Provision a Fly agent first");
        if (!issuingDid) throw new Error("Publish or select an issuing DID first");
        await issueHosted({ data: { agentId: flyAgent.id, bundleId: bundle.id, issuingDid } });
        return;
      }

      if (!activeAgent) throw new Error("Create an issuer agent first");
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new Error("Not signed in");

      const meta = (activeAgent.metadata ?? {}) as { issuerDid?: string };
      const issuerDid = meta.issuerDid ?? (await simulatedDid(activeAgent.id));
      const subjectDid = await simulatedDid(`${bundle.id}:subject`);
      const patient = findPatient(bundle.bundle as unknown as FhirBundle);
      const dob = (patient?.["birthDate"] as string | undefined) ?? null;

      // Data minimisation: the credential carries the digest and, at most, a
      // derived age assurance. Name, title and birth date are the standard
      // re-identification pair for health data and never leave the console.
      const claims = {
        summaryDigest: bundle.digest,
        credentialType: "InternationalPatientSummary",
        ...(dob ? { over18: isOver18(dob) } : {}),
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
      toast.success(mode === "fly" ? "Credential offer created on the hosted agent" : "Credential issued");
      void qc.invalidateQueries({ queryKey: ["credentials"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-8">
      <SectionHeading
        eyebrow="Identus"
        title="Identifiers & credentials"
        description="Issue verifiable credentials over a patient summary. Simulated mode derives did:prism-shaped identifiers locally; Fly.io mode runs a real Identus Cloud Agent in Docker with Postgres and a PRISM node."
      />

      <Tabs value={mode} onValueChange={(v) => setMode(v as "simulated" | "fly")}>
        <TabsList>
          <TabsTrigger value="simulated">Simulated</TabsTrigger>
          <TabsTrigger value="fly">Fly.io Cloud Agent</TabsTrigger>
        </TabsList>

        <TabsContent value="simulated" className="mt-4">
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
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-xl border border-border bg-card/60 transition-colors hover:border-primary/40 px-3 py-2"
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
        </TabsContent>

        <TabsContent value="fly" className="mt-4 space-y-4">
          <FlyAgentPanel />

          <Panel title="Issuer DIDs" subtitle="Published did:prism with an assertionMethod key">
            {flyAgent ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusDot status={flyAgent.readiness_status === "ready" ? "ok" : "pending"} />
                  <span className="text-sm">{flyAgent.label}</span>
                  <Badge variant="secondary" className="text-[11px]">
                    {flyAgent.readiness_status}
                  </Badge>
                </div>
                <Button size="sm" onClick={() => publishDid.mutate()} disabled={publishDid.isPending}>
                  <KeyRound className="mr-1.5 h-4 w-4" /> Create & publish issuer DID
                </Button>
                {dids.data?.usable.length ? (
                  <div className="space-y-1.5">
                    <Label>Issuing DID</Label>
                    <Select value={issuingDid} onValueChange={setIssuingDid}>
                      <SelectTrigger>
                        <SelectValue placeholder="Choose a published DID" />
                      </SelectTrigger>
                      <SelectContent>
                        {dids.data.usable.map((d) => (
                          <SelectItem key={d} value={d}>
                            {d.slice(0, 34)}…
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No publishable DID yet. Publication is confirmed by the PRISM node and can take a minute.
                  </p>
                )}
                {dids.data?.excluded.length ? (
                  <ul className="space-y-1">
                    {dids.data.excluded.map((d) => (
                      <li key={d.did} className="text-[11px] text-muted-foreground">
                        {d.did.slice(0, 26)}… — {d.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Provision the Fly agent above to publish a DID.</p>
            )}
          </Panel>
        </TabsContent>
      </Tabs>

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
            The credential carries the summary digest and, when the summary has a birth date, a derived{" "}
            <code>over18</code> boolean — never the patient's name, the summary title, the birth date itself, or
            any clinical content.
          </p>
          <Button onClick={() => issue.mutate()} disabled={issue.isPending || !selectedBundle}>
            <BadgeCheck className="mr-1.5 h-4 w-4" />
            {mode === "fly" ? "Issue on hosted agent" : "Issue credential"}
          </Button>
        </div>
      </Panel>

      <Panel title="Credentials" subtitle="Issued records">
        {creds.data?.length ? (
          <ul className="space-y-2">
            {creds.data.map((c) => (
              <li key={c.id} className="space-y-1 rounded-xl border border-border bg-card/60 transition-colors hover:border-primary/40 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Fingerprint className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <Badge variant="secondary" className="text-[11px]">
                    {c.state}
                  </Badge>
                  <Badge variant="outline">{c.simulated ? "simulated" : "hosted agent"}</Badge>
                  <span className="min-w-0 truncate font-mono text-xs">
                    {(c.claims as { summaryDigest?: string } | null)?.summaryDigest?.slice(0, 16) ??
                      "IPS credential"}
                    …
                  </span>
                </div>
                <TruncatedMono value={c.issuer_did} label="issuer" head={18} tail={8} />
                <TruncatedMono value={c.subject_did} label="subject" head={18} tail={8} />
                <TruncatedMono value={c.credential_jwt} label="jwt" head={16} tail={8} />
                <TruncatedMono value={c.invitation_url} label="invitation" head={22} tail={6} />
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
