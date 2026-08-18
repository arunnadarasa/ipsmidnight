import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2, PackageCheck, Rocket, Terminal } from "lucide-react";
import { Panel } from "@/components/SectionHeading";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusDot, TruncatedMono } from "@/components/MonoValue";
import {
  anchorQueuedSummary,
  deployAnchorContract,
  getRunnerStatus,
  pollRunnerJob,
  prepareRunnerMachine,
  verifyAnchorMembership,
} from "@/lib/midnight/runner.functions";

/**
 * Submitting and verifying an anchor are per-row actions in the anchors list, so
 * the polling for both lives in this hook rather than inside the panel below.
 */
export function useAnchorSubmission(appPrefix: string | null | undefined) {
  const qc = useQueryClient();
  const submitFn = useServerFn(anchorQueuedSummary);
  const verifyFn = useServerFn(verifyAnchorMembership);
  const pollFn = useServerFn(pollRunnerJob);
  const [active, setActive] = useState<{ anchorId: string; jobId: string } | null>(null);

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
      setActive({ anchorId, jobId: r.jobId });
      toast.info("Proving on the runner — this takes a couple of minutes.");
      void qc.invalidateQueries({ queryKey: ["anchors"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const verify = useMutation({
    mutationFn: (anchorId: string) => verifyFn({ data: { appPrefix: appPrefix!, anchorId } }),
    onSuccess: (r, anchorId) => {
      setActive({ anchorId, jobId: r.jobId });
      toast.info("Reading the contract ledger for this commitment…");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return {
    submit,
    verify,
    activeAnchorId: active?.anchorId ?? null,
    activeKind: job.data?.kind ?? null,
    log: job.data?.log ?? "",
  };
}

function LogTail({ log }: { log: string }) {
  if (!log) return null;
  return (
    <pre className="max-h-40 overflow-auto rounded-md bg-secondary/60 p-3 font-mono text-[11px] leading-relaxed">
      {log}
    </pre>
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
      toast.info("Installing the Midnight toolchain on the runner — a few minutes.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deploy = useMutation({
    mutationFn: () => deployFn({ data: { appPrefix: appPrefix! } }),
    onSuccess: (r) => {
      setJobId(r.jobId);
      toast.info("Deploying — proving the contract's initial state.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const s = status.data;
  const running = Boolean(job.data?.running) || Boolean(jobId);
  const contract = s?.contract ?? null;
  const busy = prepare.isPending || deploy.isPending || running;

  return (
    <Panel title="Anchor contract" subtitle="Compact · IpsAnchorRegistry">
      {!appPrefix ? (
        <p className="text-sm text-muted-foreground">
          Provision the Fly stack first — the contract runner lives alongside the node and proof server.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot
              status={contract ? "ok" : s?.current ? "pending" : s?.machine ? "pending" : "error"}
            />
            <Badge variant="secondary" className="text-[11px]">
              runner: {s?.machine ? s.machine.state : "not created"}
            </Badge>
            <Badge variant="secondary" className="text-[11px]">
              toolchain: {s?.current ? "ready" : s?.ready ? "out of date" : "not installed"}
            </Badge>
            {contract ? <Badge className="bg-success/15 text-success">deployed</Badge> : null}
          </div>

          {contract ? (
            <div className="space-y-2 text-sm">
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

          {running ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Terminal className="h-3.5 w-3.5" />
              {job.data?.kind === "deploy" ? "Deploying" : "Preparing"} on the runner…
            </p>
          ) : null}
          <LogTail log={job.data?.log ?? ""} />
        </div>
      )}
    </Panel>
  );
}
