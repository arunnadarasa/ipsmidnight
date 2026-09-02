import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, CheckCircle2, Cloud, Copy, ExternalLink, Loader2, RefreshCw, Rocket, Trash2, Wrench } from "lucide-react";
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
  stackDiagnostics,

  destroyFullStack,
  repairFullStack,
  repairIdentusOnly,
  repairMidnightOnly,

  reconnectStack,
  provisionHalf,
  listStacks,
} from "@/lib/stack.functions";
import { StackTimeline } from "@/components/deploy/StackTimeline";
import { identusSteps, midnightSteps, isNotProvisioned, type StackStep } from "@/lib/stack-steps";

type MachineLike = { name: string; id: string; state: string; region?: string | null };

type ReadinessResult = {
  identus: {
    urls: { appName: string; agentUrl: string; didcommUrl: string };
    machines: MachineLike[];
    health: { probes: { name: string; ok: boolean; status: number | null; detail: string }[]; ready: boolean };
    status: string;
    ready: boolean;
    hasKey?: boolean;
    exists?: boolean | null;
  };
  midnight: {
    urls: { appName: string; indexerUrl: string; indexerWsUrl: string; proofUrl: string; nodeUrl: string };
    machines: MachineLike[];
    probes: { indexer: { ok: boolean; status: number | null; detail: string }; proof: { ok: boolean; status: number | null; detail: string }; blockHeight: number | null };
    status: string;
    ready: boolean;
    exists?: boolean | null;
  };

  allReady: boolean;
  appPrefix: string;
};

/** Slow exec-based reads, fetched separately from the fast readiness check. */
type DiagnosticsResult = {
  logTail: string | null;
  /** Full boot-log tail plus why it is (or isn't) available. */
  agentLog?: {
    summary: string | null;
    raw: string | null;
    source: string;
    reason: string | null;
  } | null;
  /** Observed Postgres credential state for the agent, or null when unchecked. */
  dbProbe?: {
    roles: string[];
    authOk: boolean | null;
    agentConfigMatches: boolean | null;
    detail: string | null;
    verifiers?: string[];
    hba?: string | null;
    probeHost?: string | null;
  } | null;

  diagnostics: {
    indexerLog: string | null;
    nodeLog: string | null;
    nodeRpcFromNode: string | null;
    nodeRpcFromIndexer: string | null;
    ips?: string | null;
  } | null;
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
  identus?: { status: string; last_error: string | null; agent_url: string | null; machines?: MachineLike[] };
  midnight?: { status: string; last_error: string | null; indexer_url: string | null; proof_url: string | null; machines?: MachineLike[] };
};


function DeployConsole() {
  const qc = useQueryClient();
  const provision = useServerFn(provisionFullStack);
  const check = useServerFn(checkFullStack);
  const destroy = useServerFn(destroyFullStack);
  const repair = useServerFn(repairFullStack);
  const repairIdentus = useServerFn(repairIdentusOnly);
  const repairMidnight = useServerFn(repairMidnightOnly);

  const reconnect = useServerFn(reconnectStack);
  const provisionOneHalf = useServerFn(provisionHalf);



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

  // Poll readiness for the selected stack while it is not ready. `placeholderData`
  // keeps the last good payload on screen when a poll fails, so a dropped check
  // never redraws the timelines as a stack that has done nothing.
  const readiness = useQuery<ReadinessResult | null>({
    queryKey: ["stack_readiness", selected?.appPrefix],
    queryFn: async () => (selected ? ((await check({ data: { appPrefix: selected.appPrefix } })) as ReadinessResult) : null),
    enabled: Boolean(selected),
    placeholderData: (prev) => prev,
    retry: 1,
    refetchInterval: (q) => {
      const d = q.state.data as ReadinessResult | null;
      if (d && d.allReady) return false;
      const started = selected ? new Date(selected.created_at).getTime() : Date.now();
      // Back off once a stack has been booting for more than ten minutes.
      return Date.now() - started > 10 * 60 * 1000 ? 20000 : 12000;
    },
  });

  // Slow exec-based reads. They only matter once a half is known unhealthy, and
  // they live in their own request so a hanging exec degrades to "no log
  // captured" rather than killing the readiness poll.
  const readDiagnostics = useServerFn(stackDiagnostics);
  const needsIdentusLog = Boolean(readiness.data && !readiness.data.identus.ready && readiness.data.identus.exists !== false);
  const needsMidnightLog = Boolean(readiness.data && !readiness.data.midnight.ready && readiness.data.midnight.exists !== false);
  const diagnosticsQuery = useQuery<DiagnosticsResult | null>({
    queryKey: ["stack_diagnostics", selected?.appPrefix, needsIdentusLog, needsMidnightLog],
    queryFn: async () =>
      selected
        ? ((await readDiagnostics({
            data: { appPrefix: selected.appPrefix, identus: needsIdentusLog, midnight: needsMidnightLog },
          })) as DiagnosticsResult)
        : null,
    enabled: Boolean(selected) && (needsIdentusLog || needsMidnightLog),
    placeholderData: (prev) => prev,
    retry: false,
    refetchInterval: 45000,
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
    onSuccess: (result) => {
      toast.success(
        result.dbProbe?.authOk === true && result.dbProbe.agentConfigMatches === true
          ? "Database login verified and a fresh agent boot started. Midnight untouched."
          : "Identus repair applied; verification is still pending.",
      );
      qc.invalidateQueries({ queryKey: ["stacks"] });
      void readiness.refetch();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Identus repair failed"),
  });

  const repairMidnightMut = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("No stack selected");
      return repairMidnight({ data: { appPrefix: selected.appPrefix, region: selected.region } });
    },
    onSuccess: () => {
      toast.success("Midnight machines re-applied — the indexer is reconnecting to the node RPC.");
      qc.invalidateQueries({ queryKey: ["stacks"] });
      void readiness.refetch();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Midnight repair failed"),
  });


  const reconnectMut = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error("No stack selected");
      return reconnect({ data: { appPrefix: selected.appPrefix, region: selected.region } });
    },
    onSuccess: (res) => {
      if (res.midnight.ok) toast.success("Stack reconnected — a new agent admin key is stored.");
      else toast.warning(`Agent reconnected, but Midnight failed: ${res.midnight.error}`);
      qc.invalidateQueries({ queryKey: ["stacks"] });
      void readiness.refetch();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Reconnect failed"),
  });


  // Brings back a half whose Fly app no longer exists (destroyed, or a provision
  // that never got off the ground) without touching the healthy half.
  const provisionHalfMut = useMutation({
    mutationFn: async (kind: "identus" | "midnight") => {
      if (!selected) throw new Error("No stack selected");
      return provisionOneHalf({ data: { appPrefix: selected.appPrefix, kind, region: selected.region } });
    },
    onSuccess: (_res, kind) => {
      toast.success(`${kind === "identus" ? "Identus" : "Midnight"} half provisioning — machines are booting.`);
      qc.invalidateQueries({ queryKey: ["stacks"] });
      void readiness.refetch();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Provisioning failed"),
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
              checkError={
                readiness.isError
                  ? readiness.error instanceof Error
                    ? readiness.error.message
                    : "The readiness check failed"
                  : null
              }
              diagnostics={diagnosticsQuery.data ?? null}
              checking={readiness.isFetching}
              onCheck={() => {
                void readiness.refetch();
                void diagnosticsQuery.refetch();
              }}

              onDestroy={() => destroyMut.mutate()}
              destroyLoading={destroyMut.isPending}
              onRepair={() => repairMut.mutate()}
              repairLoading={repairMut.isPending}
              onRepairIdentus={() => repairIdentusMut.mutate()}
              repairIdentusLoading={repairIdentusMut.isPending}
              onRepairMidnight={() => repairMidnightMut.mutate()}
              repairMidnightLoading={repairMidnightMut.isPending}

              onReconnect={() => reconnectMut.mutate()}
              reconnectLoading={reconnectMut.isPending}
              onProvisionHalf={(kind) => provisionHalfMut.mutate(kind)}
              provisionHalfLoading={provisionHalfMut.isPending}

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
  checkError,
  diagnostics: stackDiags,
  checking,
  onCheck,
  onDestroy,
  destroyLoading,
  onRepair,
  repairLoading,
  onRepairIdentus,
  repairIdentusLoading,
  onRepairMidnight,
  repairMidnightLoading,

  onReconnect,
  reconnectLoading,
  onProvisionHalf,
  provisionHalfLoading,
}: {
  stack: StackSummary;
  readiness: ReadinessResult | null | undefined;
  readinessLoading: boolean;
  checkError: string | null;
  diagnostics: DiagnosticsResult | null;
  checking: boolean;
  onCheck: () => void;
  onDestroy: () => void;
  destroyLoading: boolean;
  onRepair: () => void;
  repairLoading: boolean;
  onRepairIdentus: () => void;
  repairIdentusLoading: boolean;
  onRepairMidnight: () => void;
  repairMidnightLoading: boolean;

  onReconnect: () => void;
  reconnectLoading: boolean;
  onProvisionHalf: (kind: "identus" | "midnight") => void;
  provisionHalfLoading: boolean;

}) {
  const identus = readiness?.identus;
  const midnight = readiness?.midnight;
  const allReady = readiness?.allReady ?? false;
  // No live payload and a failed check = we know nothing. Fall back to the last
  // machine states persisted on the deployment row rather than an empty list.
  const identusMachines = identus?.machines ?? stack.identus?.machines ?? undefined;
  const midnightMachines = midnight?.machines ?? stack.midnight?.machines ?? undefined;
  const checkFailed = Boolean(checkError && !readiness);


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
          <Button variant="outline" size="sm" onClick={onRepairMidnight} disabled={repairMidnightLoading}>
            {repairMidnightLoading ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wrench className="mr-1.5 h-3.5 w-3.5" />
            )}
            Fix indexer
          </Button>

          <Button variant="outline" size="sm" onClick={onReconnect} disabled={reconnectLoading}>
            {reconnectLoading ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wrench className="mr-1.5 h-3.5 w-3.5" />
            )}
            Reconnect
          </Button>

          <Button variant="ghost" size="sm" onClick={onDestroy} disabled={destroyLoading} className="text-destructive hover:text-destructive">
            {destroyLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
            Destroy both
          </Button>
        </div>
      </div>

      {checkError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          <p className="font-medium">Couldn&apos;t reach the stack check.</p>
          <p className="mt-1 break-words text-destructive/80">{checkError}</p>
          <p className="mt-1 text-destructive/80">
            The machines below show the last known state — this is not a sign that provisioning failed.
          </p>
          <Button variant="outline" size="sm" className="mt-2" onClick={onCheck} disabled={checking}>
            {checking ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            Retry check
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {(() => {
          const identusStepList = identusSteps({
            appName: identus?.urls.appName ?? `${stack.appPrefix}-identus`,
            machines: identusMachines,
            probes: identus?.health.probes,
            logTail: stackDiags?.logTail ?? null,
            hasKey: identus?.hasKey ?? true,
            exists: identus?.exists ?? null,
            checkFailed,
          });
          const midnightStepList = midnightSteps({
            appName: midnight?.urls.appName ?? `${stack.appPrefix}-midnight`,
            machines: midnightMachines,
            probes: midnight?.probes,
            diagnostics: stackDiags?.diagnostics ?? null,
            exists: midnight?.exists ?? null,
            checkFailed,
          });

          const identusAbsent = identus?.exists === false && isNotProvisioned(identusStepList);
          const midnightAbsent = midnight?.exists === false && isNotProvisioned(midnightStepList);
          return (
            <>
              <HalfCard
                title="Identus Cloud Agent"
                subtitle="Credential issuance"
                status={identusAbsent ? "not provisioned" : checkFailed ? "unknown" : identus?.status ?? stack.identus?.status ?? "unknown"}
                ready={identus?.ready ?? false}
                loading={readinessLoading}
                // A derived URL for an app that does not exist is a dead link.
                url={identusAbsent ? null : identus?.urls.agentUrl ?? stack.identus?.agent_url ?? null}
                urlLabel="agent"
                error={stack.identus?.last_error}
                readyTo={allReady ? "/app/identus" : null}
                readyLabel="Publish DID & issue"
                machines={identusMachines}
                steps={identusStepList}
                bootLog={identusAbsent ? null : stackDiags?.agentLog ?? null}
                dbProbe={identusAbsent ? null : stackDiags?.dbProbe ?? null}

                startedAt={identusAbsent ? null : stack.created_at}
                regionLabel={`Region ${stack.region}`}
                onRetry={onCheck}
                retrying={checking}
                absent={identusAbsent}
                onProvision={() => onProvisionHalf("identus")}
                provisionLoading={provisionHalfLoading}
                provisionLabel="Provision Identus"
              />
              <HalfCard
                title="Midnight Undeployed"
                subtitle="On-chain anchoring"
                status={midnightAbsent ? "not provisioned" : checkFailed ? "unknown" : midnight?.status ?? stack.midnight?.status ?? "unknown"}
                ready={midnight?.ready ?? false}
                loading={readinessLoading}
                url={midnightAbsent ? null : midnight?.urls.indexerUrl ?? stack.midnight?.indexer_url ?? null}
                urlLabel="indexer"
                error={stack.midnight?.last_error}
                readyTo={allReady ? "/app/midnight" : null}
                readyLabel="Deploy contract & anchor"
                machines={midnightMachines}
                steps={midnightStepList}
                startedAt={midnightAbsent ? null : stack.created_at}
                regionLabel={`Region ${stack.region}`}
                onRetry={onCheck}
                retrying={checking}
                absent={midnightAbsent}
                onProvision={() => onProvisionHalf("midnight")}
                provisionLoading={provisionHalfLoading}
                provisionLabel="Provision Midnight"
              />
            </>
          );
        })()}
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
  bootLog,
  dbProbe,

  startedAt,
  regionLabel,
  onRetry,
  retrying,
  absent,
  onProvision,
  provisionLoading,
  provisionLabel,
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
  /** Full boot-log tail for this half, when one was captured. */
  bootLog?: { summary: string | null; raw: string | null; source: string; reason: string | null } | null;
  /** Observed state of the agent's database login, never assumed. */
  dbProbe?: {
    roles: string[];
    authOk: boolean | null;
    agentConfigMatches: boolean | null;
    detail: string | null;
    verifiers?: string[];
    hba?: string | null;
    probeHost?: string | null;
  } | null;

  startedAt: string | null;
  regionLabel?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  /** The Fly app for this half does not exist — nothing is booting. */
  absent?: boolean;
  onProvision?: () => void;
  provisionLoading?: boolean;
  provisionLabel?: string;
}) {
  const tone = ready ? "text-success" : status === "error" ? "text-destructive" : "text-muted-foreground";
  // Machines left behind by an earlier repair can confuse the private-DNS
  // picture, so name them instead of letting them sit silently in the drawer.
  const stray = (machines ?? []).filter((m) => m.state === "stopped" || m.state === "failed");
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

        {absent ? (
          <div className="space-y-3 rounded-xl border border-border bg-card/60 transition-colors hover:border-primary/40 px-3 py-3">
            <p className="text-xs text-muted-foreground">
              No Fly app exists for this half — it was either destroyed or never finished provisioning. Nothing is
              booting, so there is nothing to repair.
            </p>
            {onProvision ? (
              <Button size="sm" onClick={onProvision} disabled={provisionLoading} className="w-full">
                {provisionLoading ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Rocket className="mr-1.5 h-3.5 w-3.5" />
                )}
                {provisionLabel ?? "Provision"}
              </Button>
            ) : null}
          </div>
        ) : (
          <StackTimeline
            steps={steps}
            startedAt={startedAt}
            {...(regionLabel ? { regionLabel } : {})}
            {...(onRetry ? { onRetry } : {})}
            {...(retrying !== undefined ? { retrying } : {})}
          />
        )}

        {!absent && dbProbe ? (
          <div className="rounded-xl border border-border bg-card/60 px-3 py-2 text-[11px]">
            <div className="flex items-center gap-1.5">
              <StatusDot status={dbProbe.authOk === true ? "ok" : dbProbe.authOk === false ? "error" : "pending"} />
              <span className="text-muted-foreground">
                Database credentials:{" "}
                {dbProbe.authOk === true
                  ? "remote password login verified"
                  : dbProbe.authOk === false
                    ? "not verified — remote login failed"
                    : "not checked"}
              </span>
            </div>
            {dbProbe.roles.length ? (
              <p className="mt-1 break-words text-muted-foreground">Roles: {dbProbe.roles.join(", ")}</p>
            ) : null}
            {dbProbe.verifiers?.length ? (
              <p className="mt-1 break-words text-muted-foreground">
                Stored password type: {dbProbe.verifiers.join(", ")}
              </p>
            ) : null}
            <div className="mt-1 flex items-center gap-1.5">
              <StatusDot
                status={dbProbe.agentConfigMatches === true ? "ok" : dbProbe.agentConfigMatches === false ? "error" : "pending"}
              />
              <span className="text-muted-foreground">
                Agent configuration:{" "}
                {dbProbe.agentConfigMatches === true
                  ? "verified credential loaded"
                  : dbProbe.agentConfigMatches === false
                    ? "stale credential detected"
                    : "not checked"}
              </span>
            </div>
            {dbProbe.detail ? <p className="mt-1 break-words text-muted-foreground">{dbProbe.detail}</p> : null}
            {dbProbe.hba ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-muted-foreground">Database host rules</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
                  {dbProbe.hba}
                </pre>
              </details>
            ) : null}
          </div>
        ) : null}



        {!absent && bootLog && (bootLog.raw || bootLog.reason) ? (
          <details className="rounded-xl border border-border bg-card/60 px-2.5 py-1.5">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">Current and previous boot logs</summary>
            {bootLog.raw ? (
              <>
                <div className="mt-1.5 flex justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => {
                      void navigator.clipboard.writeText(bootLog.raw ?? "");
                      toast.success("Copied.");
                    }}
                  >
                    <Copy className="mr-1 h-3 w-3" /> Copy log
                  </Button>
                </div>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {bootLog.raw}
                </pre>
              </>
            ) : (
              <p className="mt-1.5 text-[11px] text-muted-foreground">{bootLog.reason}</p>
            )}
          </details>
        ) : null}

        {machines?.length ? (
          <details className="rounded-xl border border-border bg-card/60 transition-colors hover:border-primary/40 px-2.5 py-1.5">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">Fly machines ({machines.length})</summary>
            <ul className="mt-1.5 space-y-1">
              {machines.map((m) => (
                <li key={m.id ?? m.name} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-mono">{m.name}</span>
                  <span className="shrink-0 text-muted-foreground">{m.state}</span>
                </li>
              ))}
            </ul>
            {stray.length ? (
              <p className="mt-2 text-[11px] text-warning">
                {stray.length === 1 ? "1 machine is" : `${stray.length} machines are`} stopped or failed (
                {stray.map((m) => m.name).join(", ")}). Leftovers from an earlier repair can sit in the same private-DNS
                process group — run Repair if this half stays unhealthy.
              </p>
            ) : null}
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
