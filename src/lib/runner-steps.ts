/**
 * Presentation-only mapping from a Midnight runner job (kind + log tail +
 * result) onto the same ordered step model the Deploy page timeline renders.
 * Nothing here calls the backend: the poller already returns everything below.
 */
import type { StackStep, StepState } from "@/lib/stack-steps";

export type RunnerJobView = {
  kind: "bootstrap" | "deploy" | "anchor" | "verify" | null;
  running: boolean;
  log: string;
  result: { ok: boolean; error?: string; address?: string; member?: boolean } | null;
};

type Spec = {
  key: string;
  label: string;
  hint?: string;
  /** Step is complete once the log matches this (or the job result says so). */
  done?: RegExp;
  /** Step is in flight once the log matches this. */
  active?: RegExp;
};

/**
 * Marks the first unmatched step as active while the job runs, and turns it red
 * with the error detail when the job died.
 */
function resolve(specs: Spec[], job: RunnerJobView, finalDone: boolean): StackStep[] {
  const log = job.log ?? "";
  const failed = Boolean(job.result && !job.result.ok);
  let openSeen = false;

  return specs.map((spec, i) => {
    const isLast = i === specs.length - 1;
    const done = isLast ? finalDone : Boolean(spec.done && spec.done.test(log)) || finalDone;
    if (done) return { key: spec.key, label: spec.label, state: "done" as StepState };

    if (!openSeen) {
      openSeen = true;
      if (failed) {
        return {
          key: spec.key,
          label: spec.label,
          state: "failed" as StepState,
          detail: job.result?.error ?? "The runner job failed — see the log.",
        };
      }
      const started = job.running || Boolean(spec.active && spec.active.test(log));
      return {
        key: spec.key,
        label: spec.label,
        state: (started ? "active" : "pending") as StepState,
        ...(spec.hint ? { hint: spec.hint } : {}),
      };
    }
    return {
      key: spec.key,
      label: spec.label,
      state: "pending" as StepState,
      ...(spec.hint ? { hint: spec.hint } : {}),
    };
  });
}

const BOOTSTRAP: Spec[] = [
  { key: "fetch", label: "Fetching the contract bundle", done: /STEP:staged|BOOTSTRAP_OK/ },
  { key: "staged", label: "Compact artifacts staged", done: /STEP:deps|BOOTSTRAP_OK/ },
  {
    key: "deps",
    label: "Installing the Midnight SDK",
    hint: "first install takes a few minutes",
    done: /BOOTSTRAP_OK/,
  },
  { key: "ready", label: "Toolchain ready" },
];

const DEPLOY: Spec[] = [
  {
    key: "endpoints",
    label: "Indexer and proof server reachable",
    done: /\[wallet\]|deploying IpsAnchorRegistry/,
    active: /waiting for stack/,
  },
  { key: "wallet", label: "Wallet synced to the chain tip", done: /deploying IpsAnchorRegistry/ },
  {
    key: "prove",
    label: "Proving the initial contract state",
    hint: "the first proof takes 30–120s",
    done: /DEPLOY_OK/,
  },
  { key: "deployed", label: "Contract deployed" },
];

const ANCHOR: Spec[] = [
  { key: "wallet", label: "Wallet synced to the chain tip", done: /anchoring commitment/ },
  {
    key: "prove",
    label: "Proving the anchor transaction",
    hint: "proving takes 30–120s",
    done: /ANCHOR_OK/,
  },
  { key: "confirmed", label: "Submitted and confirmed in a block" },
];

const VERIFY: Spec[] = [
  { key: "read", label: "Reading the contract ledger" },
  { key: "answer", label: "Membership answer returned" },
];

/** Steps for whatever job is currently running (or just finished). */
export function runnerJobSteps(job: RunnerJobView): StackStep[] {
  const ok = Boolean(job.result?.ok);
  switch (job.kind) {
    case "deploy":
      return resolve(DEPLOY, job, ok);
    case "anchor":
      return resolve(ANCHOR, job, ok);
    case "verify":
      return resolve(VERIFY, job, Boolean(job.result));
    default:
      return resolve(BOOTSTRAP, job, ok);
  }
}

/**
 * Resting checklist shown when no job is in flight, so the panel always reads
 * as progress rather than two badges.
 */
export function runnerRestingSteps(status: {
  machine: { state: string } | null;
  ready: string | null;
  current: boolean;
  contract: unknown;
}): StackStep[] {
  const machineDone = status.machine?.state === "started";
  const steps: StackStep[] = [
    {
      key: "machine",
      label: "Runner machine started",
      state: machineDone ? "done" : status.machine ? "active" : "pending",
      ...(status.machine ? { value: status.machine.state } : {}),
    },
    {
      key: "toolchain",
      label: "Midnight toolchain installed",
      state: status.current ? "done" : "pending",
      ...(status.ready && !status.current ? { value: "out of date" } : {}),
    },
    {
      key: "contract",
      label: "Anchor contract deployed",
      state: status.contract ? "done" : "pending",
    },
  ];
  return steps;
}
