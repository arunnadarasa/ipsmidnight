/**
 * Derives an ordered, progressive step list for each half of an IPS stack from
 * the payload already returned by `checkFullStack`. Pure presentation logic —
 * no extra backend calls.
 */

export type StepState = "pending" | "active" | "done" | "failed";

export type StackStep = {
  key: string;
  label: string;
  state: StepState;
  /** Short right-hand value: machine state, block height, app name… */
  value?: string;
  /** Inline hint shown while the step is active or pending. */
  hint?: string;
  /** Error detail; only rendered when state === "failed". */
  detail?: string;
};

type MachineLike = {
  name: string;
  id: string;
  state: string;
  region?: string | null;
  /** Populated by the Fly readers: last non-zero exit / OOM detail. */
  exitCode?: number | null;
  oomKilled?: boolean | null;
  restarts?: number | null;
  detail?: string | null;
};
type Probe = { name: string; ok: boolean; status: number | null; detail: string };

/** A machine that keeps exiting non-zero is failing even while state is "started". */
function crashDetail(m: MachineLike): string | null {
  if (m.oomKilled) return m.detail ?? `${m.name} ran out of memory.`;
  if (typeof m.exitCode === "number" && m.exitCode !== 0 && (m.restarts ?? 0) > 1) {
    return m.detail ?? `${m.name} exited with code ${m.exitCode} and is restarting.`;
  }
  return null;
}

function machineStep(
  key: string,
  label: string,
  machines: MachineLike[] | undefined,
  machineName: string,
  hint?: string,
): StackStep {
  const m = machines?.find((x) => x.name === machineName);
  if (!m) {
    return { key, label, state: machines?.length ? "active" : "pending", ...(hint ? { hint } : {}) };
  }
  const crash = crashDetail(m);
  const s = (m.state ?? "").toLowerCase();
  const state: StepState = crash
    ? "failed"
    : s === "started"
      ? "done"
      : s === "stopped" || s === "failed" || s === "destroyed"
        ? "failed"
        : "active";
  return {
    key,
    label,
    state,
    value: crash ? "restarting" : m.state,
    ...(hint ? { hint } : {}),
    ...(state === "failed" ? { detail: crash ?? `Machine ${m.name} is ${m.state}.` } : {}),
  };
}


function probeStep(
  key: string,
  label: string,
  probes: Probe[] | undefined,
  probeName: string,
  gateReady: boolean,
  hint?: string,
): StackStep {
  const p = probes?.find((x) => x.name === probeName);
  if (p?.ok) return { key, label, state: "done", value: p.status ? String(p.status) : "ok" };
  if (!gateReady) return { key, label, state: "pending", ...(hint ? { hint } : {}) };
  return {
    key,
    label,
    state: "active",
    ...(hint ? { hint } : {}),
    ...(p?.detail ? { detail: p.detail } : {}),
  };
}

/** Recognises a failure that only a fresh agent database can clear. */
function isDbMigrationFailure(logTail?: string | null) {
  return Boolean(logTail && /psqlexception|migrating schema|flyway|syntax error|does not exist/i.test(logTail));
}

/** Surfaces the agent's own log line on the health step so a boot crash is readable. */
function withLog(step: StackStep, logTail?: string | null): StackStep {
  if (step.state === "done" || !logTail) return step;
  const hint = isDbMigrationFailure(logTail)
    ? "agent database migration failed — run Fix agent DB to rebuild it"
    : step.hint;
  return {
    ...step,
    ...(hint ? { hint } : {}),
    detail: step.detail ? `${step.detail} — agent log: ${logTail}` : `agent log: ${logTail}`,
  };
}


const IDENTUS_STEP_LABELS: [string, string][] = [
  ["app", "Fly app created"],
  ["pg", "Postgres started"],
  ["prism", "PRISM node booting"],
  ["agent", "Cloud agent booting"],
  ["system", "Agent health: system"],
  ["did-registrar", "Agent health: DID registrar"],
  ["issuance", "Agent health: issuance"],
  ["connections", "Agent health: connections"],
];

const MIDNIGHT_STEP_LABELS: [string, string][] = [
  ["app", "Fly app created"],
  ["node", "Node started"],
  ["indexer", "Indexer started"],
  ["proof", "Proof server started"],
  ["indexer-sync", "Indexer syncing"],
  ["proof-ready", "Proof server ready"],
];

/**
 * The Fly app does not exist (never provisioned, or destroyed). Every step is
 * pending — no spinner, no false "app created" tick.
 */
function notProvisionedSteps(labels: [string, string][]): StackStep[] {
  return labels.map(([key, label], i) => ({
    key,
    label,
    state: "pending" as StepState,
    ...(i === 0 ? { hint: "not provisioned — no Fly app exists for this half" } : {}),
  }));
}

/**
 * The readiness check itself failed, so we know nothing about this half. This is
 * NOT the same as "no progress": showing a fresh spinner here would claim the
 * stack has completed zero steps when it may be perfectly healthy on Fly.
 */
function unknownSteps(labels: [string, string][]): StackStep[] {
  return labels.map(([key, label], i) => ({
    key,
    label,
    state: "pending" as StepState,
    ...(i === 0
      ? { hint: "status unknown — the readiness check could not reach Fly. Hit Check to retry." }
      : {}),
  }));
}

/** True when the derived step list is the "nothing provisioned" placeholder. */
export function isNotProvisioned(steps: StackStep[]) {
  return steps.length > 0 && steps.every((s) => s.state === "pending");
}


export function identusSteps(input: {
  appName?: string | null;
  machines?: MachineLike[] | undefined;
  probes?: Probe[] | undefined;
  status?: string;
  /** Last error line from the cloud-agent log, when diagnostics pulled one. */
  logTail?: string | null;
  /** False when no admin key is stored for this stack, so probes cannot run. */
  hasKey?: boolean;
  /** Whether the Fly app itself exists; false = never provisioned / destroyed. */
  exists?: boolean | null;
  /** The readiness check errored — we have no live signal at all. */
  checkFailed?: boolean;
}): StackStep[] {
  const { appName, machines, probes, logTail, hasKey = true, exists, checkFailed } = input;
  if (exists === false) return notProvisionedSteps(IDENTUS_STEP_LABELS);
  if (checkFailed && !machines?.length) return unknownSteps(IDENTUS_STEP_LABELS);

  // The app *name* is derived from the prefix, so it can never prove existence —
  // only a confirmed Fly app (or a running machine) counts as created.
  const created = exists === true || Boolean(machines?.length);
  const agentStep = machineStep("agent", "Cloud agent booting", machines, "identus-cloud-agent", "4 GB machine, JVM start");
  // While the agent is crash-looping, the health probes can only ever spin — keep
  // them pending so the failed boot step is the one thing the user reads.
  const bootFailed = agentStep.state === "failed";
  const agentUp = !bootFailed && machines?.find((m) => m.name === "identus-cloud-agent")?.state === "started";

  // No stored admin key means every probe returns nothing forever; say so instead
  // of spinning on "Agent health: system".
  const missingKey = created && !hasKey;
  const keyless = (step: StackStep): StackStep =>
    missingKey
      ? {
          ...step,
          state: "failed",
          detail: "No admin key stored for this stack — use Reconnect to mint a new key on the running agent.",
        }
      : step;

  const steps: StackStep[] = [
    {
      key: "app",
      label: "Fly app created",
      state: created ? "done" : "active",
      ...(appName ? { value: appName } : {}),
    },
    machineStep("pg", "Postgres started", machines, "identus-postgres", "creates four databases and their app roles"),
    machineStep("prism", "PRISM node booting", machines, "identus-prism-node"),
    withLog(agentStep, logTail),
    keyless(
      withLog(
        probeStep("system", "Agent health: system", probes, "system", agentUp, "first boot migrates four databases, ~4 min"),
        bootFailed ? null : logTail,
      ),
    ),

    probeStep("did-registrar", "Agent health: DID registrar", probes, "did-registrar", agentUp && !missingKey),
    probeStep("issuance", "Agent health: issuance", probes, "issuance", agentUp && !missingKey),
    probeStep("connections", "Agent health: connections", probes, "connections", agentUp && !missingKey),
  ];


  return normalize(steps);
}

export function midnightSteps(input: {
  appName?: string | null;
  machines?: MachineLike[] | undefined;
  probes?:
    | {
        indexer: { ok: boolean; status: number | null; detail: string };
        proof: { ok: boolean; status: number | null; detail: string };
        blockHeight: number | null;
      }
    | undefined;
  /** Indexer log / node-RPC reachability, surfaced on the sync step when it stalls. */
  diagnostics?:
    | {
        indexerLog: string | null;
        nodeRpcFromNode: string | null;
        nodeRpcFromIndexer: string | null;
        ips?: string | null;
      }
    | null
    | undefined;
  /** Whether the Fly app itself exists; false = never provisioned / destroyed. */
  exists?: boolean | null;
  /** The readiness check errored — we have no live signal at all. */
  checkFailed?: boolean;
}): StackStep[] {
  const { appName, machines, probes, diagnostics, exists, checkFailed } = input;
  if (exists === false) return notProvisionedSteps(MIDNIGHT_STEP_LABELS);
  if (checkFailed && !machines?.length) return unknownSteps(MIDNIGHT_STEP_LABELS);

  const created = exists === true || Boolean(machines?.length);
  const nodeUp = machines?.find((m) => m.name === "midnight-node")?.state === "started";
  const indexerUp = machines?.find((m) => m.name === "midnight-indexer")?.state === "started";


  const steps: StackStep[] = [
    {
      key: "app",
      label: "Fly app created",
      state: created ? "done" : "active",
      ...(appName ? { value: appName } : {}),
    },
    machineStep("node", "Node started", machines, "midnight-node", "undeployed devnet"),
    machineStep("indexer", "Indexer started", machines, "midnight-indexer"),
    machineStep("proof", "Proof server started", machines, "midnight-proof"),
    {
      key: "indexer-sync",
      label: "Indexer syncing",
      state: probes?.indexer.ok ? "done" : indexerUp || nodeUp ? "active" : "pending",
      ...(probes?.blockHeight != null ? { value: `block ${probes.blockHeight}` } : {}),
      ...(() => {
        if (probes?.indexer.ok) return {};
        const diag = [
          diagnostics?.nodeRpcFromIndexer ? `indexer→node: ${diagnostics.nodeRpcFromIndexer}` : null,
          diagnostics?.nodeRpcFromNode ? `node RPC: ${diagnostics.nodeRpcFromNode}` : null,
          diagnostics?.ips ? `app IPs: ${diagnostics.ips}` : null,
          diagnostics?.indexerLog ? `indexer log: ${diagnostics.indexerLog.slice(-600)}` : null,
        ]
          .filter(Boolean)
          .join(" — ");
        const detail = [probes?.indexer.detail, diag].filter(Boolean).join(" — ");
        return detail ? { detail } : {};
      })(),
      hint:
        probes && !probes.indexer.ok && probes.blockHeight === null && indexerUp && nodeUp
          ? "the indexer answers but has ingested no blocks — press Fix indexer to republish the node RPC and restart the indexer against it"
          : "ingests blocks from the node's RPC, published through the Fly edge",
    },


    {
      key: "proof-ready",
      label: "Proof server ready",
      state: probes?.proof.ok ? "done" : indexerUp ? "active" : "pending",
      ...(probes && !probes.proof.ok && probes.proof.detail ? { detail: probes.proof.detail } : {}),
    },
  ];
  return normalize(steps);
}

/** Only the first non-done step stays "active"; later ones fall back to pending. */
function normalize(steps: StackStep[]): StackStep[] {
  let seenOpen = false;
  return steps.map((s) => {
    if (s.state === "done" || s.state === "failed") return s;
    if (seenOpen) return { ...s, state: "pending" as StepState };
    seenOpen = true;
    return { ...s, state: "active" as StepState };
  });
}

export function stepProgress(steps: StackStep[]) {
  const done = steps.filter((s) => s.state === "done").length;
  const failed = steps.some((s) => s.state === "failed");
  return { done, total: steps.length, allDone: done === steps.length, failed };
}

export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
