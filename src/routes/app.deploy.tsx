import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, CheckCircle2, Cloud, ExternalLink, Loader2, RefreshCw, Rocket, Trash2, Wrench } from "lucide-react";
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
import { FLY_REGIONS } from "@/lib/midnight/shared";
import {
  provisionFullStack,
  checkFullStack,
  destroyFullStack,
  repairFullStack,
  repairIdentusOnly,
  reconnectStack,
  listStacks,
} from "@/lib/stack.functions";
import { StackTimeline } from "@/components/deploy/StackTimeline";
import { identusSteps, midnightSteps, type StackStep } from "@/lib/stack-steps";

type MachineLike = { name: string; id: string; state: string; region?: string | null };

type ReadinessResult = {
  identus: {
    urls: { appName: string; agentUrl: string; didcommUrl: string };
    machines: MachineLike[];
    health: { probes: { name: string; ok: boolean; status: number | null; detail: string }[]; ready: boolean };
    status: string;
    ready: boolean;
    logTail?: string | null;
    hasKey?: boolean;
  };
  midnight: {
    urls: { appName: string; indexerUrl: string; indexerWsUrl: string; proofUrl: string; nodeUrl: string };
    machines: MachineLike[];
    probes: { indexer: { ok: boolean; status: number | null; detail: string }; proof: { ok: boolean; status: number | null; detail: string }; blockHeight: number | null };
    status: string;
    ready: boolean;
  };
  allReady: boolean;
  appPrefix: string;
};

export const Route = createFileRoute("/app/deploy")({
  head: () => ({
    meta: [
      { title: "Deploy IPS stack — IPS Console" },
      {
        name: "description",
        content:
          "Provision both the Identus Cloud Agent and the Midnight Undeployed stack on Fly.io in one step.",
      },
      { property: "og:title", content: "Deploy IPS stack — IPS Console" },
      {
        property: "og:description",
        content: "One provisioning flow for credential issuance and on-chain anchoring infrastructure.",
      },
    ],
  }),
  component: DeployConsole,
});

type StackSummary = {
  appPrefix: string;
  region: string;
  created_at: string;
  identus?: { status: string; last_error: string | null; agent_url: string | null };
  midnight?: { status: string; last_error: string | null; indexer_url: string | null; proof_url: string | null };
};

function DeployConsole() {
  const qc = useQueryClient();
  const provision = useServerFn(provisionFullStack);
  const check = useServerFn(checkFullStack);
  const destroy = useServerFn(destroyFullStack);
  const repair = useServerFn(repairFullStack);
  const repairIdentus = useServerFn(repairIdentusOnly);
  const reconnect = useServerFn(reconnectStack);



  const [prefix, setPrefix] = useState("");
  const [label, setLabel] = useState("");
  const [region, setRegion] = useState<string>("lhr");
  const [activePrefix, setActivePrefix] = useState<string | null>(null);

  const stacksQuery = useQuery({
    queryKey: ["stacks"],
    queryFn: () => listStacks(),
    refetchInterval: (q) => {
      // keep polling while any stack is still provisioning/error
      const data = q.state.data as StackSummary[] | undefined;
      if (!data?.length) return false;
      return data.some((s) => inProgress(s)) ? 8000 : false;
    },
  });

  const stacks = (stacksQuery.data ?? []) as StackSummary[];
  const selected = useMemo(
    () => stacks.find((s) => s.appPrefix === (activePrefix ?? stacks[0]?.appPrefix)) ?? null,
    [stacks, activePrefix],
  );

  // Poll readiness for the selected stack while it is not ready.
  const readiness = useQuery<ReadinessResult | null>({
    queryKey: ["stack_readiness", selected?.appPrefix],
    queryFn: async () => (selected ? ((await check({ data: { appPrefix: selected.appPrefix } })) as ReadinessResult) : null),
    enabled: Boolean(selected),
    refetchInterval: (q) => {
      const d = q.state.data as ReadinessResult | null;
      if (d && d.allReady) return false;
      const started = selected ? new Date(selected.created_at).getTime() : Date.now();
      // Back off once a stack has been booting for more than ten minutes.
      return Date.now() - started > 10 * 60 * 1000 ? 20000 : 12000;
    },
  });

  const provisionMut = useMutation({
    mutationFn: () =>
      provision({ data: { appPrefix: prefix, region, ...(label.trim() ? { label: label.trim() } : {}) } }),
    onSuccess: (res) => {
      toast.success(`IPS stack provisioned — Identus ${res.identus.ok ? "ok" : "failed"}, Midnight ${res.midnight.ok ? "ok" : "failed"}.`);
      setActivePrefix(res.appPrefix);
      setPrefix("");
      setLabel("");
      qc.invalidateQueries({ queryKey: ["stacks"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Provisioning failed"),
  });

  const repairMut = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("No stack selected");
      return repair({ data: { appPrefix: selected.appPrefix, region: selected.region } });
    },
    onSuccess: (res) => {
      const failed = [!res.identus.ok ? "Identus" : null, !res.midnight.ok ? "Midnight" : null].filter(Boolean);
      if (failed.length) toast.warning(`Repair partially applied — ${failed.join(" and ")} failed.`);
      else toast.success("Stack config re-applied — machines restarting.");
      qc.invalidateQueries({ queryKey: ["stacks"] });
      void readiness.refetch();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Repair failed"),
  });

  const repairIdentusMut = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("No stack selected");
      return repairIdentus({ data: { appPrefix: selected.appPrefix, region: selected.region } });
    },
    onSuccess: () => {
      toast.success("Identus database recreated — the agent is rebooting. Midnight untouched.");
      qc.invalidateQueries({ queryKey: ["stacks"] });
      void readiness.refetch();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Identus repair failed"),
  });


  const destroyMut = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("No stack selected");
      return destroy({ data: { appPrefix: selected.appPrefix } });
    },
    onSuccess: () => {
      toast.success("IPS stack destroyed.");
      setActivePrefix(null);
      qc.invalidateQueries({ queryKey: ["stacks"] });
      qc.invalidateQueries({ queryKey: ["stack_readiness"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Destruction failed"),
  });

  return (
    <div className="space-y-8">
      <SectionHeading
        eyebrow="Infrastructure"
        title="Deploy your IPS stack"
        description="One action stands up both the Identus Cloud Agent (credential issuance) and the Midnight Undeployed stack (on-chain anchoring) on Fly.io. They run as separate Fly apps under a shared prefix."
      />

      {stacks.length === 0 ? (
        <Panel title="Provision a new stack" subtitle="Identus + Midnight in one flow">
          <ProvisionForm
            prefix={prefix}
            setPrefix={setPrefix}
            label={label}
            setLabel={setLabel}
            region={region}
            setRegion={setRegion}
            onSubmit={() => provisionMut.mutate()}
            loading={provisionMut.isPending}
          />
        </Panel>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {stacks.map((s) => (
              <button
                key={s.appPrefix}
                onClick={() => setActivePrefix(s.appPrefix)}
                className={
                  "rounded-md border px-3 py-1.5 text-xs transition-colors " +
                  (s.appPrefix === selected?.appPrefix
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-card/40 text-muted-foreground hover:text-foreground")
                }
              >
                <span className="font-mono">{s.appPrefix}</span>
                <StackPill s={s} className="ml-2" />
              </button>
            ))}
            <span className="text-xs text-muted-foreground">+ provision a new stack below</span>
          </div>

          {selected ? (
            <StackDetail
              stack={selected}
              readiness={readiness.data}
              readinessLoading={readiness.isFetching}
              checking={readiness.isFetching}
              onCheck={() => void readiness.refetch()}
              onDestroy={() => destroyMut.mutate()}
              destroyLoading={destroyMut.isPending}
              onRepair={() => repairMut.mutate()}
              repairLoading={repairMut.isPending}
              onRepairIdentus={() => repairIdentusMut.mutate()}
              repairIdentusLoading={repairIdentusMut.isPending}

            />
          ) : null}

          <Panel title="Provision another stack" subtitle="Optional — most users need one">
            <ProvisionForm
              prefix={prefix}
              setPrefix={setPrefix}
              label={label}
              setLabel={setLabel}
              region={region}
              setRegion={setRegion}
              onSubmit={() => provisionMut.mutate()}
              loading={provisionMut.isPending}
              compact
            />
          </Panel>
        </div>
      )}
    </div>
  );
}

function inProgress(s: StackSummary) {
  const i = s.identus?.status;
  const m = s.midnight?.status;
  return (i && i !== "ready" && i !== "error") || (m && m !== "ready" && m !== "error") || i === "error" || m === "error";
}

function StackPill({ s, className = "" }: { s: StackSummary; className?: string }) {
  const iOk = s.identus?.status === "ready";
  const mOk = s.midnight?.status === "ready";
  const all = iOk && mOk;
  const anyErr = s.identus?.status === "error" || s.midnight?.status === "error";
  return (
    <span className={"font-mono text-[10px] " + className}>
      {all ? "● ready" : anyErr ? "● needs retry" : "● provisioning"}
    </span>
  );
}

function ProvisionForm({
  prefix,
  setPrefix,
  label,
  setLabel,
  region,
  setRegion,
  onSubmit,
  loading,
  compact,
}: {
  prefix: string;
  setPrefix: (v: string) => void;
  label: string;
  setLabel: (v: string) => void;
  region: string;
  setRegion: (v: string) => void;
  onSubmit: () => void;
  loading: boolean;
  compact?: boolean;
}) {
  return (
    <form
      className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="pf-prefix">App prefix</Label>
        <Input
          id="pf-prefix"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          placeholder="e.g. acme-ips"
          autoCapitalize="none"
          autoCorrect="off"
          className="font-mono"
          required
        />
        <p className="text-xs text-muted-foreground">Creates <span className="font-mono">{prefix || "<prefix>"}-identus</span> and <span className="font-mono">{prefix || "<prefix>"}-midnight</span>.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pf-region">Fly region</Label>
        <Select value={region} onValueChange={setRegion}>
          <SelectTrigger id="pf-region"><SelectValue /></SelectTrigger>
          <SelectContent>
            {FLY_REGIONS.map((r) => (
              <SelectItem key={r.code} value={r.code}>{r.label} ({r.code})</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="sm:hidden" />
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          className="sm:mt-0"
        />
      </div>
      <div className="flex items-end">
        <Button type="submit" disabled={loading || prefix.trim().length < 3} className="w-full sm:w-auto">
          {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Rocket className="mr-1.5 h-4 w-4" />}
          Provision
        </Button>
      </div>
      {!compact ? (
        <p className="text-xs text-muted-foreground sm:col-span-3">
          First boot migrates four databases on the Identus side; expect ~5 minutes before the agent reports ready.
        </p>
      ) : null}
    </form>
  );
}

function StackDetail({
  stack,
  readiness,
  readinessLoading,
  checking,
  onCheck,
  onDestroy,
  destroyLoading,
  onRepair,
  repairLoading,
  onRepairIdentus,
  repairIdentusLoading,
}: {
  stack: StackSummary;
  readiness: ReadinessResult | null | undefined;
  readinessLoading: boolean;
  checking: boolean;
  onCheck: () => void;
  onDestroy: () => void;
  destroyLoading: boolean;
  onRepair: () => void;
  repairLoading: boolean;
  onRepairIdentus: () => void;
  repairIdentusLoading: boolean;

}) {
  const identus = readiness?.identus;
  const midnight = readiness?.midnight;
  const allReady = readiness?.allReady ?? false;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
        <div className="flex items-center gap-2">
          <Cloud className="h-4 w-4 text-primary" />
          <span className="font-mono text-sm">{stack.appPrefix}</span>
        </div>
        <p className="text-xs text-muted-foreground sm:truncate">
          Region {stack.region} · provisioned {new Date(stack.created_at).toLocaleString()}
        </p>
        <div className="flex flex-wrap items-center gap-2 [&>*]:flex-1 sm:[&>*]:flex-none">
          <Button variant="outline" size="sm" onClick={onCheck} disabled={checking}>
            {checking ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            Check
          </Button>
          <Button variant="outline" size="sm" onClick={onRepair} disabled={repairLoading}>
            {repairLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Wrench className="mr-1.5 h-3.5 w-3.5" />}
            Repair config
          </Button>
          <Button variant="outline" size="sm" onClick={onRepairIdentus} disabled={repairIdentusLoading}>
            {repairIdentusLoading ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wrench className="mr-1.5 h-3.5 w-3.5" />
            )}
            Fix agent DB
          </Button>

          <Button variant="ghost" size="sm" onClick={onDestroy} disabled={destroyLoading} className="text-destructive hover:text-destructive">
            {destroyLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
            Destroy both
          </Button>
        </div>
      </div>


      <div className="grid gap-4 lg:grid-cols-2">
        <HalfCard
          title="Identus Cloud Agent"
          subtitle="Credential issuance"
          status={identus?.status ?? stack.identus?.status ?? "unknown"}
          ready={identus?.ready ?? false}
          loading={readinessLoading}
          url={identus?.urls.agentUrl ?? stack.identus?.agent_url ?? null}
          urlLabel="agent"
          error={stack.identus?.last_error}
          readyTo={allReady ? "/app/identus" : null}
          readyLabel="Publish DID & issue"
          machines={identus?.machines}
          steps={identusSteps({
            appName: identus?.urls.appName ?? `${stack.appPrefix}-identus`,
            machines: identus?.machines,
            probes: identus?.health.probes,
            logTail: identus?.logTail ?? null,
          })}
          startedAt={stack.created_at}
          regionLabel={`Region ${stack.region}`}
          onRetry={onCheck}
          retrying={checking}
        />
        <HalfCard
          title="Midnight Undeployed"
          subtitle="On-chain anchoring"
          status={midnight?.status ?? stack.midnight?.status ?? "unknown"}
          ready={midnight?.ready ?? false}
          loading={readinessLoading}
          url={midnight?.urls.indexerUrl ?? stack.midnight?.indexer_url ?? null}
          urlLabel="indexer"
          error={stack.midnight?.last_error}
          readyTo={allReady ? "/app/midnight" : null}
          readyLabel="Deploy contract & anchor"
          machines={midnight?.machines}
          steps={midnightSteps({
            appName: midnight?.urls.appName ?? `${stack.appPrefix}-midnight`,
            machines: midnight?.machines,
            probes: midnight?.probes,
          })}
          startedAt={stack.created_at}
          regionLabel={`Region ${stack.region}`}
          onRetry={onCheck}
          retrying={checking}
        />
      </div>

      {allReady ? (
        <Panel title="Stack ready" subtitle="Both halves are healthy">
          <div className="flex flex-wrap items-center gap-3">
            <Badge className="bg-success/15 text-success">
              <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Both stacks ready
            </Badge>
            <Button asChild size="sm" variant="outline">
              <Link to="/app/identus">Identus <ArrowRight className="ml-1 h-3.5 w-3.5" /></Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to="/app/midnight">Midnight <ArrowRight className="ml-1 h-3.5 w-3.5" /></Link>
            </Button>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}




function HalfCard({
  title,
  subtitle,
  status,
  ready,
  loading,
  url,
  urlLabel,
  error,
  readyTo,
  readyLabel,
  machines,
  steps,
  startedAt,
  regionLabel,
  onRetry,
  retrying,
}: {
  title: string;
  subtitle: string;
  status: string;
  ready: boolean;
  loading: boolean;
  url: string | null;
  urlLabel: string;
  error?: string | null | undefined;
  readyTo?: string | null | undefined;
  readyLabel: string;
  machines?: MachineLike[] | undefined;
  steps: StackStep[];
  startedAt: string | null;
  regionLabel?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const tone = ready ? "text-success" : status === "error" ? "text-destructive" : "text-muted-foreground";
  return (
    <Panel
      title={title}
      subtitle={subtitle}
      actions={
        <span className={"flex items-center gap-1.5 text-xs " + tone}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <StatusDot status={ready ? "ok" : status === "error" ? "error" : "pending"} />}
          {status}
        </span>
      }
    >
      <div className="space-y-3">
        {url ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">{urlLabel}:</span>
            <TruncatedMono value={url} head={28} tail={10} />
            <a href={url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        ) : null}

        {error ? (
          <p className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        ) : null}

        <StackTimeline
          steps={steps}
          startedAt={startedAt}
          {...(regionLabel ? { regionLabel } : {})}
          {...(onRetry ? { onRetry } : {})}
          {...(retrying !== undefined ? { retrying } : {})}
        />

        {machines?.length ? (
          <details className="rounded-md border border-border bg-card/40 px-2.5 py-1.5">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">Fly machines ({machines.length})</summary>
            <ul className="mt-1.5 space-y-1">
              {machines.map((m) => (
                <li key={m.id ?? m.name} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-mono">{m.name}</span>
                  <span className="shrink-0 text-muted-foreground">{m.state}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {ready && readyTo ? (
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link to={readyTo}>{readyLabel} <ArrowRight className="ml-1.5 h-3.5 w-3.5" /></Link>
          </Button>
        ) : null}
      </div>
    </Panel>
  );
}
