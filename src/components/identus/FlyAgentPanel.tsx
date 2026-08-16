import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Activity, Loader2, Rocket, Stethoscope, Trash2, Wrench } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Panel } from "@/components/SectionHeading";
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
import { FLY_REGIONS } from "@/lib/midnight/shared";
import {
  checkIdentusAgent,
  destroyIdentusAgent,
  diagnoseIdentusAgent,
  provisionIdentusAgent,
  repairIdentusEndpoints,
} from "@/lib/identus/fly.functions";

export function FlyAgentPanel() {
  const qc = useQueryClient();
  const provision = useServerFn(provisionIdentusAgent);
  const check = useServerFn(checkIdentusAgent);
  const destroy = useServerFn(destroyIdentusAgent);
  const diagnose = useServerFn(diagnoseIdentusAgent);
  const repair = useServerFn(repairIdentusEndpoints);

  const [prefix, setPrefix] = useState("");
  const [region, setRegion] = useState("lhr");
  const [showDiag, setShowDiag] = useState(false);

  const { data: deployment } = useQuery({
    queryKey: ["identus_deployment"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fly_deployments")
        .select("*")
        .eq("kind", "identus")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const appPrefix = deployment?.app_prefix ?? null;

  const health = useQuery({
    queryKey: ["identus_health", appPrefix],
    enabled: Boolean(appPrefix),
    // Poll while the agent migrates its four databases on first boot.
    refetchInterval: (q) => (q.state.data?.ready ? 60_000 : 15_000),
    queryFn: () => check({ data: { appPrefix: appPrefix! } }),
  });

  const diagnostics = useQuery({
    queryKey: ["identus_diagnostics", appPrefix],
    enabled: Boolean(appPrefix) && showDiag,
    queryFn: () => diagnose({ data: { appPrefix: appPrefix! } }),
  });

  const doProvision = useMutation({
    mutationFn: () => provision({ data: { appPrefix: prefix, region } }),
    onSuccess: (r) => {
      toast.success(`Agent ${r.appName} provisioning — first boot takes a few minutes.`);
      void qc.invalidateQueries({ queryKey: ["identus_deployment"] });
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const doDestroy = useMutation({
    mutationFn: () => destroy({ data: { appPrefix: appPrefix! } }),
    onSuccess: () => {
      toast.success("Agent destroyed");
      void qc.invalidateQueries({ queryKey: ["identus_deployment"] });
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const doRepair = useMutation({
    mutationFn: () => repair({ data: { appPrefix: appPrefix! } }),
    onSuccess: (r) => toast.success(`DIDComm endpoint set to ${r.didcommUrl}`),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Panel title="Fly.io Cloud Agent" subtitle="postgres · prism-node · identus-cloud-agent">
      {deployment ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot status={health.data?.ready ? "ok" : "pending"} />
            <span className="text-sm">{deployment.app_prefix}-identus</span>
            <Badge variant="secondary">{deployment.region}</Badge>
            <Badge variant={health.data?.ready ? "default" : "outline"}>
              {health.data?.ready ? "ready" : (deployment.status ?? "provisioning")}
            </Badge>
            {health.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
          </div>

          <div className="space-y-1">
            <TruncatedMono value={deployment.agent_url} label="agent" head={30} tail={6} />
            <TruncatedMono value={deployment.didcomm_url} label="didcomm" head={30} tail={6} />
          </div>

          {deployment.last_error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {deployment.last_error}
            </p>
          ) : null}

          <ul className="space-y-1.5">
            {(health.data?.machines ?? []).map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2 text-xs">
                <StatusDot status={m.state === "started" ? "ok" : "pending"} />
                <span className="font-mono">{m.name}</span>
                <Badge variant="outline" className="text-[11px]">
                  {m.state}
                </Badge>
              </li>
            ))}
          </ul>

          {health.data?.probes?.length ? (
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {health.data.probes.map((p) => (
                <li key={p.name} className="flex items-center gap-2 text-xs">
                  <StatusDot status={p.ok ? "ok" : "pending"} />
                  <span className="min-w-0 truncate">
                    {p.name} — {p.ok ? "ok" : p.detail}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              Waiting on the agent — the first boot migrates four databases and can take 3–5 minutes.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void health.refetch()}>
              <Activity className="mr-1.5 h-4 w-4" /> Check health
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowDiag((v) => !v)}>
              <Stethoscope className="mr-1.5 h-4 w-4" /> {showDiag ? "Hide" : "Diagnostics"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => doRepair.mutate()} disabled={doRepair.isPending}>
              <Wrench className="mr-1.5 h-4 w-4" /> Repair DIDComm endpoint
            </Button>
            <Button size="sm" variant="destructive" onClick={() => doDestroy.mutate()} disabled={doDestroy.isPending}>
              <Trash2 className="mr-1.5 h-4 w-4" /> Destroy
            </Button>
          </div>

          {showDiag ? (
            <div className="space-y-2 rounded-md border border-border bg-card/40 p-3">
              {diagnostics.isLoading ? (
                <p className="text-xs text-muted-foreground">Reading machine state…</p>
              ) : (
                (diagnostics.data?.machines ?? []).map((m) => (
                  <div key={m.id} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono">{m.name}</span>
                      <Badge variant="outline" className="text-[11px]">
                        {m.state}
                      </Badge>
                      {m.name === "identus-cloud-agent" && !m.didcommPortPublished ? (
                        <Badge variant="destructive" className="text-[11px]">
                          port 8090 not published
                        </Badge>
                      ) : null}
                    </div>
                    {m.checks.map((c) => (
                      <p key={c.name} className="break-words text-[11px] text-muted-foreground">
                        {c.name}: {c.status} {c.output ? `— ${c.output}` : ""}
                      </p>
                    ))}
                    {m.events.map((e, i) => (
                      <p key={`${e.type}-${i}`} className="text-[11px] text-muted-foreground">
                        {e.type} · {e.status}
                      </p>
                    ))}
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Provision a dedicated Fly app running Postgres, the PRISM node and the Identus Cloud Agent. Same
            Docker images as a local compose stack, reachable over HTTPS.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="identus-prefix">App prefix</Label>
              <Input
                id="identus-prefix"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="ips-demo"
              />
              <p className="text-xs text-muted-foreground">Creates {prefix || "<prefix>"}-identus.fly.dev</p>
            </div>
            <div className="space-y-1.5">
              <Label>Region</Label>
              <Select value={region} onValueChange={setRegion}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FLY_REGIONS.map((r) => (
                    <SelectItem key={r.code} value={r.code}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button onClick={() => doProvision.mutate()} disabled={doProvision.isPending || prefix.length < 3}>
            {doProvision.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="mr-1.5 h-4 w-4" />
            )}
            Provision agent
          </Button>
        </div>
      )}
    </Panel>
  );
}
