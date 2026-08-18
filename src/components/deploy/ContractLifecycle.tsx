import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ChevronDown, Loader2, PackageCheck, Rocket } from "lucide-react";
import { Panel } from "@/components/SectionHeading";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TruncatedMono } from "@/components/MonoValue";
import { StackTimeline } from "@/components/deploy/StackTimeline";
import { clampSteps, runnerJobSteps, runnerRestingSteps } from "@/lib/runner-steps";
import { stepProgress, type StackStep } from "@/lib/stack-steps";
import {
  anchorQueuedSummary,
  deployAnchorContract,
  getRunnerStatus,
  pollRunnerJob,
  prepareRunnerMachine,
  verifyAnchorMembership,
} from "@/lib/midnight/runner.functions";

/** Keeps derived step progress monotonic across a 3 kB rolling log tail. */
function useMonotonicSteps() {
  const ref = useRef<{ id: string | null; done: number }>({ id: null, done: 0 });
  return (id: string | null, steps: StackStep[]) => {
    if (ref.current.id !== id) ref.current = { id, done: 0 };
    const { done, failed } = stepProgress(steps);
    if (done > ref.current.done) ref.current.done = done;
    return failed ? steps : clampSteps(steps, ref.current.done);
  };
}

/**
 * Submitting and verifying an anchor are per-row actions in the anchors list, so
 * the polling for both lives in this hook rather than inside the panel below.
 */
export function useAnchorSubmission(appPrefix: string | null | undefined) {
  const qc = useQueryClient();
  const submitFn = useServerFn(anchorQueuedSummary);
  const verifyFn = useServerFn(verifyAnchorMembership);
  const pollFn = useServerFn(pollRunnerJob);
  const [active, setActive] = useState<{ anchorId: string; jobId: string; startedAt: string } | null>(
    null,
  );
  const monotonic = useMonotonicSteps();

  const job = useQuery({
    queryKey: ["midnight_runner_job", active?.jobId],
    enabled: Boolean(appPrefix && active),
    // Proving takes minutes; a slow poll keeps the exec calls cheap.
    refetchInterval: 5_000,
    queryFn: async () => {
      const result = await pollFn({
        data: { appPrefix: appPrefix!, jobId: active!.jobId, anchorId: active!.anchorId },
      });
      if (result.result) {
        setActive(null);
        void qc.invalidateQueries({ queryKey: ["anchors"] });
        if (!result.result.ok) {
          toast.error(result.result.error);
        } else if (result.kind === "verify") {
          if (result.result.member) {
            toast.success("Commitment found in the contract's on-chain set.");
          } else {
            toast.warning("The commitment is NOT in the on-chain set — this anchor does not verify.");
          }
        } else {
          toast.success(
            `Anchored${result.result.blockHeight ? ` in block #${result.result.blockHeight}` : ""}.`,
          );
        }
      }
      return result;
    },
  });

  const submit = useMutation({
    mutationFn: (anchorId: string) => submitFn({ data: { appPrefix: appPrefix!, anchorId } }),
    onSuccess: (r, anchorId) => {
      setActive({ anchorId, jobId: r.jobId, startedAt: new Date().toISOString() });
      toast.info("Proving on the runner — this takes a couple of minutes.");
      void qc.invalidateQueries({ queryKey: ["anchors"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const verify = useMutation({
    mutationFn: (anchorId: string) => verifyFn({ data: { appPrefix: appPrefix!, anchorId } }),
    onSuccess: (r, anchorId) => {
      setActive({ anchorId, jobId: r.jobId, startedAt: new Date().toISOString() });
      toast.info("Reading the contract ledger for this commitment…");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const j = job.data;
  const steps = j
    ? monotonic(
        active?.jobId ?? null,
        runnerJobSteps({
          kind: j.kind,
          running: Boolean(j.running),
          log: j.log ?? "",
          result: j.result ?? null,
        }),
      )
    : [];

  return {
    submit,
    verify,
    activeAnchorId: active?.anchorId ?? null,
    activeKind: j?.kind ?? null,
    startedAt: active?.startedAt ?? null,
    steps,
    log: j?.log ?? "",
  };
}

export function LogTail({ log }: { log: string }) {
  const [open, setOpen] = useState(false);
  if (!log) return null;
  return (
    <div className="space-y-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        className="h-7 px-2 text-xs text-muted-foreground"
      >
        <ChevronDown className={"mr-1 h-3.5 w-3.5 transition-transform " + (open ? "rotate-180" : "")} />
        {open ? "Hide runner log" : "Show runner log"}
      </Button>
      {open ? (
        <div className="overflow-hidden rounded-xl border border-border bg-secondary/50">
          <div className="flex items-center gap-1.5 border-b border-border/70 px-3 py-1.5">
            <span className="h-2 w-2 rounded-full bg-destructive/50" />
            <span className="h-2 w-2 rounded-full bg-warning/60" />
            <span className="h-2 w-2 rounded-full bg-success/60" />
            <span className="ml-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              runner log
            </span>
          </div>
          <pre className="max-h-40 overflow-auto p-3 font-mono text-[11px] leading-relaxed">{log}</pre>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One-click deploy of the compiled Compact contract. The work happens on a
 * dedicated "runner" machine inside the same Fly app as the node, indexer and
 * proof server, because proving needs a persistent disk and long-lived
 * connections that the app runtime does not have.
 */
export function ContractLifecycle({
  appPrefix,
  region,
  stackReady,
}: {
  appPrefix: string | null | undefined;
  region: string;
  stackReady: boolean;
}) {
  const qc = useQueryClient();
  const statusFn = useServerFn(getRunnerStatus);
  const prepareFn = useServerFn(prepareRunnerMachine);
  const deployFn = useServerFn(deployAnchorContract);
  const pollFn = useServerFn(pollRunnerJob);
  const [jobId, setJobId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const monotonic = useMonotonicSteps();

  const status = useQuery({
    queryKey: ["midnight_runner", appPrefix],
    enabled: Boolean(appPrefix),
    refetchInterval: 20_000,
    queryFn: () => statusFn({ data: { appPrefix: appPrefix! } }),
  });

  const job = useQuery({
    queryKey: ["midnight_runner_job", jobId],
    enabled: Boolean(appPrefix && jobId),
    refetchInterval: 5_000,
    queryFn: async () => {
      const result = await pollFn({ data: { appPrefix: appPrefix!, jobId: jobId! } });
      if (result.result) {
        setJobId(null);
        void qc.invalidateQueries({ queryKey: ["midnight_runner", appPrefix] });
        if (result.result.ok) {
          toast.success(result.kind === "deploy" ? "Contract deployed." : "Runner ready.");
        } else {
          toast.error(result.result.error);
        }
      }
      return result;
    },
  });

  const prepare = useMutation({
    mutationFn: () => prepareFn({ data: { appPrefix: appPrefix!, region } }),
    onSuccess: (r) => {
      setJobId(r.jobId);
      setStartedAt(new Date().toISOString());
      toast.info("Installing the Midnight toolchain on the runner — a few minutes.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deploy = useMutation({
    mutationFn: () => deployFn({ data: { appPrefix: appPrefix! } }),
    onSuccess: (r) => {
      setJobId(r.jobId);
      setStartedAt(new Date().toISOString());
      toast.info("Deploying — proving the contract's initial state.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const s = status.data;
  const j = job.data;
  const running = Boolean(j?.running) || Boolean(jobId);
  const contract = s?.contract ?? null;
  const busy = prepare.isPending || deploy.isPending || running;

  const jobSteps = j
    ? monotonic(
        jobId,
        runnerJobSteps({
          kind: j.kind,
          running: Boolean(j.running),
          log: j.log ?? "",
          result: j.result ?? null,
        }),
      )
    : null;
  const steps =
    jobSteps ??
    runnerRestingSteps({
      machine: s?.machine ?? null,
      ready: s?.ready ?? null,
      current: Boolean(s?.current),
      contract,
    });

  return (
    <Panel title="Anchor contract" subtitle="Compact · IpsAnchorRegistry">
      {!appPrefix ? (
        <p className="text-sm text-muted-foreground">
          Provision the Fly stack first — the contract runner lives alongside the node and proof server.
        </p>
      ) : (
        <div className="space-y-4">
          <StackTimeline
            steps={steps}
            startedAt={jobSteps ? startedAt : null}
            regionLabel={
              jobSteps
                ? j?.kind === "deploy"
                  ? "deploying the contract"
                  : j?.kind === "bootstrap"
                    ? "preparing the runner"
                    : null
                : null
            }
          />

          {contract ? (
            <div className="space-y-2 text-sm">
              <Badge className="bg-success/15 text-success">deployed</Badge>
              <TruncatedMono value={contract.address} label="contract" head={14} tail={8} />
              <TruncatedMono value={contract.deploy_tx} label="deploy tx" head={14} tail={8} />
              <p className="text-xs text-muted-foreground">
                Anchors call <code className="font-mono">anchorSummary</code> with the commitment only —
                never clinical content.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              The Compact contract is compiled and bundled. Prepare the runner once, then deploy — both
              steps run on Fly, so nothing has to be done from a terminal.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => prepare.mutate()}
              disabled={busy || !stackReady}
            >
              {prepare.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <PackageCheck className="mr-1.5 h-4 w-4" />
              )}
              {s?.current ? "Re-prepare runner" : "Prepare runner"}
            </Button>
            <Button size="sm" onClick={() => deploy.mutate()} disabled={busy || !s?.current}>
              {deploy.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="mr-1.5 h-4 w-4" />
              )}
              {contract ? "Redeploy contract" : "Deploy contract"}
            </Button>
          </div>

          {!stackReady ? (
            <p className="text-xs text-muted-foreground">
              Waiting for the stack to report ready — the deploy needs the proof server and indexer.
            </p>
          ) : null}

          <LogTail log={j?.log ?? ""} />
        </div>
      )}
    </Panel>
  );
}
