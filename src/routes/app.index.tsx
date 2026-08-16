import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Activity, FileHeart, IdCard, Moon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { SectionHeading, Panel } from "@/components/SectionHeading";
import { TruncatedMono } from "@/components/MonoValue";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/app/")({
  head: () => ({
    meta: [
      { title: "Dashboard — IPS Console" },
      { name: "description", content: "Overview of patient summaries, credentials, and Midnight anchors." },
      { property: "og:title", content: "Dashboard — IPS Console" },
      { property: "og:description", content: "Track summaries, credentials, and on-chain anchors." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { data } = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => {
      const [bundles, creds, anchors, activity] = await Promise.all([
        supabase.from("ips_bundles").select("id,title,patient_name,digest,created_at").order("created_at", { ascending: false }).limit(5),
        supabase.from("credential_records").select("id,state,simulated").limit(200),
        supabase.from("midnight_anchors").select("id,status,tx_hash,digest,created_at").order("created_at", { ascending: false }).limit(5),
        supabase.from("activity_log").select("id,kind,summary,created_at").order("created_at", { ascending: false }).limit(6),
      ]);
      return {
        bundles: bundles.data ?? [],
        credentials: creds.data ?? [],
        anchors: anchors.data ?? [],
        activity: activity.data ?? [],
      };
    },
  });

  const stats = [
    { label: "Patient summaries", value: data?.bundles.length ?? 0, icon: FileHeart, to: "/app/ips" as const },
    { label: "Credentials issued", value: data?.credentials.length ?? 0, icon: IdCard, to: "/app/identus" as const },
    {
      label: "Anchors confirmed",
      value: data?.anchors.filter((a) => a.status === "confirmed").length ?? 0,
      icon: Moon,
      to: "/app/midnight" as const,
    },
    { label: "Activity events", value: data?.activity.length ?? 0, icon: Activity, to: "/app/activity" as const },
  ];

  return (
    <div className="space-y-8">
      <SectionHeading
        eyebrow="Workspace"
        title="International Patient Summary console"
        description="Compose an IPS bundle, issue it as a verifiable credential, then anchor a commitment on the Midnight Undeployed network. Clinical content stays in your workspace."
        actions={
          <Button asChild>
            <Link to="/app/ips">New summary</Link>
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(({ label, value, icon: Icon, to }) => (
          <Link key={label} to={to} className="panel p-4 transition-colors hover:border-primary/50">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{label}</span>
              <Icon className="h-4 w-4 text-primary" />
            </div>
            <p className="mt-2 font-display text-2xl font-semibold">{value}</p>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Recent summaries" subtitle="Latest IPS bundles in this workspace">
          {data?.bundles.length ? (
            <ul className="space-y-2">
              {data.bundles.map((b) => (
                <li key={b.id} className="rounded-md border border-border bg-card/40 px-3 py-2">
                  <p className="truncate text-sm font-medium">{b.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="truncate">{b.patient_name ?? "Unnamed patient"}</span>
                    <TruncatedMono value={b.digest} label="digest" head={8} tail={4} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No summaries yet. Start from a sample bundle in the Summaries workspace.
            </p>
          )}
        </Panel>

        <Panel title="Recent activity" subtitle="Audit trail of workspace events">
          {data?.activity.length ? (
            <ul className="space-y-2">
              {data.activity.map((a) => (
                <li key={a.id} className="flex items-start gap-2 text-sm">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  <span className="min-w-0">
                    <span className="block truncate">{a.summary}</span>
                    <span className="font-mono text-xs text-muted-foreground">{a.kind}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Activity appears here as you build and anchor summaries.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}
