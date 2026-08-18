import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Activity, Cloud, FileHeart, IdCard, Moon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { SectionHeading, Panel, EmptyState } from "@/components/SectionHeading";
import { TruncatedMono } from "@/components/MonoValue";
import { Reveal } from "@/components/Reveal";
import { useCountUp } from "@/hooks/use-reveal";
import { Button } from "@/components/ui/button";

function CountValue({ value }: { value: number }) {
  return <>{useCountUp(value)}</>;
}

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
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/app/deploy"><Cloud className="mr-1.5 h-4 w-4" />Provision stack</Link>
            </Button>
            <Button asChild>
              <Link to="/app/ips">New summary</Link>
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {stats.map(({ label, value, icon: Icon, to }, i) => (
          <Reveal key={label} delay={i * 70}>
            <Link
              to={to}
              className="panel hover-lift group relative block overflow-hidden p-4 sm:p-5"
            >
              <span className="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full bg-primary/8 blur-xl transition-opacity duration-300 group-hover:opacity-100 sm:opacity-70" />
              <div className="relative flex items-start justify-between gap-2">
                <span className="min-w-0 text-xs font-medium text-muted-foreground">{label}</span>
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary transition-transform duration-300 group-hover:scale-110">
                  <Icon className="h-4 w-4" />
                </span>
              </div>
              <p className="relative mt-3 font-display text-3xl font-bold tracking-tight tabular-nums">
                <CountValue value={value} />
              </p>
            </Link>
          </Reveal>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel accent title="Recent summaries" subtitle="Latest IPS bundles in this workspace">
          {data?.bundles.length ? (
            <ul className="space-y-2">
              {data.bundles.map((b) => (
                <li
                  key={b.id}
                  className="rounded-xl border border-border bg-card/60 px-3 py-2.5 transition-colors hover:border-primary/40"
                >
                  <p className="truncate text-sm font-medium">{b.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="truncate">{b.patient_name ?? "Unnamed patient"}</span>
                    <TruncatedMono value={b.digest} label="digest" head={8} tail={4} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<FileHeart className="h-6 w-6" />}
              title="No summaries yet"
              body="Start from a sample bundle in the Summaries workspace."
              action={
                <Button asChild size="sm" variant="outline">
                  <Link to="/app/ips">Open Summaries</Link>
                </Button>
              }
            />
          )}
        </Panel>

        <Panel title="Recent activity" subtitle="Audit trail of workspace events">
          {data?.activity.length ? (
            <ul className="space-y-3">
              {data.activity.map((a) => (
                <li key={a.id} className="relative flex items-start gap-3 text-sm">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_var(--hairline)]" />
                  <span className="min-w-0">
                    <span className="block truncate">{a.summary}</span>
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      {a.kind}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<Activity className="h-6 w-6" />}
              title="Nothing logged yet"
              body="Activity appears here as you build and anchor summaries."
            />
          )}
        </Panel>
      </div>
    </div>
  );
}
