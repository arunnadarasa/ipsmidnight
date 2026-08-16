import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SectionHeading, Panel } from "@/components/SectionHeading";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/app/activity")({
  head: () => ({
    meta: [
      { title: "Activity — IPS Console" },
      { name: "description", content: "Audit trail of summary, credential, and anchoring events." },
      { property: "og:title", content: "Activity — IPS Console" },
      { property: "og:description", content: "Every credential and anchor event, timestamped." },
    ],
  }),
  component: ActivityPage,
});

function ActivityPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["activity"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("activity_log")
        .select("id,kind,summary,metadata,created_at")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow="Audit"
        title="Activity"
        description="Everything this workspace has done, newest first. Clinical content is never written to the log — only identifiers and digests."
      />
      <Panel>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading activity…</p>
        ) : data?.length ? (
          <ol className="space-y-3">
            {data.map((row) => (
              <li key={row.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border pb-3 last:border-0 last:pb-0">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">{row.summary}</p>
                  <Badge variant="secondary" className="mt-1 font-mono text-[11px]">
                    {row.kind}
                  </Badge>
                </div>
                <time className="shrink-0 font-mono text-xs text-muted-foreground">
                  {new Date(row.created_at).toLocaleString()}
                </time>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No events yet.</p>
        )}
      </Panel>
    </div>
  );
}
