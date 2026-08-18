import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, FileHeart, Loader2, Save, Sparkles, Trash2, Upload } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { SectionHeading, Panel } from "@/components/SectionHeading";
import { TruncatedMono } from "@/components/MonoValue";
import { BundleBuilder } from "@/components/ips/BundleBuilder";
import { ValidationReport } from "@/components/ips/ValidationReport";
import { buildIpsBundle, emptyBuilderState, type BuilderState } from "@/lib/ips/builder";
import { validateIpsBundle } from "@/lib/ips/validate";
import { bundleDigest } from "@/lib/ips/digest";
import type { FhirBundle } from "@/lib/ips/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/app/ips")({
  head: () => ({
    meta: [
      { title: "Patient summaries — IPS Console" },
      {
        name: "description",
        content: "Build, upload, and validate FHIR International Patient Summary bundles.",
      },
      { property: "og:title", content: "Patient summaries — IPS Console" },
      { property: "og:description", content: "Guided IPS builder with structural validation." },
    ],
  }),
  component: IpsWorkspace,
});

function IpsWorkspace() {
  const qc = useQueryClient();
  const [state, setState] = useState<BuilderState>(emptyBuilderState);
  const [raw, setRaw] = useState("");

  const { data: bundles } = useQuery({
    queryKey: ["ips_bundles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ips_bundles")
        .select("id,title,patient_name,patient_dob,digest,source,created_at,bundle,validation")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: samples } = useQuery({
    queryKey: ["sample_bundles"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sample_bundles")
        .select("id,slug,title,description,provenance,bundle");
      if (error) throw error;
      return data;
    },
  });

  const builtBundle = useMemo(
    () => buildIpsBundle(state, new Date().toISOString().slice(0, 19) + "Z"),
    [state],
  );
  const parsedRaw = useMemo(() => {
    if (!raw.trim()) return null;
    try {
      return JSON.parse(raw) as FhirBundle;
    } catch {
      return "invalid" as const;
    }
  }, [raw]);

  const activeBundle: FhirBundle | null =
    parsedRaw && parsedRaw !== "invalid" ? parsedRaw : raw.trim() ? null : builtBundle;
  const validation = useMemo(
    () => (activeBundle ? validateIpsBundle(activeBundle) : null),
    [activeBundle],
  );

  const save = useMutation({
    mutationFn: async () => {
      if (!activeBundle || !validation) throw new Error("Nothing to save");
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) throw new Error("Not signed in");
      const digest = await bundleDigest(activeBundle);
      const title =
        (activeBundle.entry?.find((e) => e.resource?.resourceType === "Composition")?.resource?.[
          "title"
        ] as string | undefined) ?? state.title;
      const { error } = await supabase.from("ips_bundles").insert({
        user_id: uid,
        title: title || "International Patient Summary",
        source: raw.trim() ? "upload" : "builder",
        bundle: activeBundle as never,
        validation: validation as never,
        digest,
        patient_name: validation.patient.name,
        patient_dob: validation.patient.birthDate,
      });
      if (error) throw error;
      await supabase.from("activity_log").insert({
        user_id: uid,
        kind: "ips.saved",
        summary: `Saved summary "${title}" (${digest.slice(0, 12)}…)`,
        metadata: { digest } as never,
      });
      return digest;
    },
    onSuccess: (digest) => {
      toast.success(`Summary saved · digest ${digest.slice(0, 12)}…`);
      void qc.invalidateQueries({ queryKey: ["ips_bundles"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("ips_bundles").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Summary deleted");
      void qc.invalidateQueries({ queryKey: ["ips_bundles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const onUpload = async (file: File) => {
    const text = await file.text();
    setRaw(text);
    toast.success(`${file.name} loaded — review the validation report.`);
  };

  const download = (bundle: unknown, name: string) => {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/fhir+json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-8">
      <SectionHeading
        eyebrow="Clinical data"
        title="Patient summaries"
        description="Everything here is stored under row-level security in your workspace. Only digests and commitments ever leave it."
      />

      <Tabs defaultValue="builder">
        <TabsList>
          <TabsTrigger value="builder">Guided builder</TabsTrigger>
          <TabsTrigger value="upload">Upload FHIR</TabsTrigger>
          <TabsTrigger value="library">Library ({bundles?.length ?? 0})</TabsTrigger>
        </TabsList>

        <TabsContent value="builder" className="mt-6 space-y-6">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Panel title="Compose the summary" subtitle="Patient header and IPS sections">
              <BundleBuilder state={state} onChange={setState} />
            </Panel>

            <div className="space-y-4">
              <Panel
                title="Validation"
                subtitle="Structural IPS conformance"
                actions={
                  <Button
                    size="sm"
                    onClick={() => save.mutate()}
                    disabled={save.isPending || !validation}
                  >
                    {save.isPending ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Save
                  </Button>
                }
              >
                {validation ? <ValidationReport result={validation} /> : null}
              </Panel>

              <Panel title="Start from a sample" subtitle="Reference bundles you can adapt">
                <ul className="space-y-2">
                  {samples?.map((s) => (
                    <li key={s.id} className="rounded-xl border border-border bg-card/60 transition-colors hover:border-primary/40 p-3">
                      <p className="text-sm font-medium">{s.title}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{s.description}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setRaw(JSON.stringify(s.bundle, null, 2));
                            toast.success(`${s.title} loaded into the upload tab`);
                          }}
                        >
                          <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Load
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => download(s.bundle, s.slug)}>
                          <Download className="mr-1.5 h-3.5 w-3.5" /> JSON
                        </Button>
                      </div>
                    </li>
                  )) ?? <p className="text-sm text-muted-foreground">Loading samples…</p>}
                </ul>
              </Panel>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="upload" className="mt-6 space-y-6">
          <Panel
            title="Upload or paste a FHIR bundle"
            subtitle="application/fhir+json document bundle"
            actions={
              <>
                <label className="inline-flex">
                  <input
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void onUpload(file);
                    }}
                  />
                  <Button size="sm" variant="outline" asChild>
                    <span>
                      <Upload className="mr-1.5 h-3.5 w-3.5" /> Choose file
                    </span>
                  </Button>
                </label>
                <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !validation}>
                  <Save className="mr-1.5 h-3.5 w-3.5" /> Save
                </Button>
              </>
            }
          >
            <Textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder='{ "resourceType": "Bundle", "type": "document", "entry": [ … ] }'
              className="min-h-[280px] font-mono text-xs"
            />
            {parsedRaw === "invalid" ? (
              <p className="mt-3 text-sm text-destructive">That isn't valid JSON yet.</p>
            ) : null}
          </Panel>

          {validation && raw.trim() ? (
            <Panel title="Validation" subtitle="Structural IPS conformance">
              <ValidationReport result={validation} />
            </Panel>
          ) : null}
        </TabsContent>

        <TabsContent value="library" className="mt-6">
          <Panel>
            {bundles?.length ? (
              <ul className="space-y-3">
                {bundles.map((b) => (
                  <li
                    key={b.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="flex min-w-0 items-center gap-2 truncate text-sm font-medium">
                        <FileHeart className="h-4 w-4 shrink-0 text-primary" />
                        {b.title}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>{b.patient_name ?? "Unnamed"}</span>
                        {b.patient_dob ? <span>DOB {b.patient_dob}</span> : null}
                        <Badge variant="secondary" className="text-[11px]">
                          {b.source}
                        </Badge>
                        <TruncatedMono value={b.digest} label="digest" head={10} tail={6} />
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button size="icon" variant="ghost" aria-label="Download" onClick={() => download(b.bundle, b.title)}>
                        <Download className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Delete"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => remove.mutate(b.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No saved summaries yet — compose one in the builder or load a sample.
              </p>
            )}
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  );
}
