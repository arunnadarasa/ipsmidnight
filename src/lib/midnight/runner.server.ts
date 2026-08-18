/**
 * The Midnight "runner": a small always-on machine inside the same Fly app as
 * the node, indexer and proof server, which executes
 * scripts/deploy-midnight.mjs and scripts/anchor-midnight.mjs.
 *
 * Why a machine at all: proving needs a long-lived proof-server session, a
 * wallet, and a LevelDB private-state store on disk. The app's own runtime is
 * serverless — no persistent disk, no long connections — so it cannot host any
 * of that. The runner keeps all of it on a volume and is driven through Fly's
 * exec API.
 *
 * Fly caps exec at ~30s while proving takes minutes, so jobs are written to a
 * shell script, launched detached with nohup, and then polled: each job writes
 * a JSON result file that the poller reads.
 */
import { RUNNER, stackUrls } from "./shared";
import {
  ensureRunnerMachine,
  execOnMachine,
  findMachineByName,
  flyConfigured,
  machineEventSummary,
  startMachine,
} from "./fly.server";

export type RunnerJobKind = "bootstrap" | "deploy" | "anchor" | "verify";

export type RunnerJobResult =
  | {
      ok: true;
      address?: string;
      deployTx?: string | null;
      txId?: string | null;
      blockHeight?: number | null;
      /** verify jobs: true when the commitment is in the on-chain Set. */
      member?: boolean;
      commitment?: string;
      anchorCount?: number;
    }
  | { ok: false; error: string };

export type RunnerJob = {
  id: string;
  kind: RunnerJobKind;
  running: boolean;
  log: string;
  result: RunnerJobResult | null;
};

export type RunnerStatus = {
  configured: boolean;
  /** null when the machine does not exist yet. */
  machine: { id: string; state: string } | null;
  /** Artifact version installed on the volume, or null when never bootstrapped. */
  ready: string | null;
  /** True when the installed artifacts match the version this app expects. */
  current: boolean;
  job: RunnerJob | null;
};

const JOBS_DIR = `${RUNNER.work}/jobs`;

function jobKind(id: string): RunnerJobKind {
  if (id.startsWith("deploy-")) return "deploy";
  if (id.startsWith("anchor-")) return "anchor";
  if (id.startsWith("verify-")) return "verify";
  return "bootstrap";
}

/** Job ids are used in shell paths, so they stay strictly [a-z0-9-]. */
function newJobId(kind: RunnerJobKind, suffix?: string) {
  const stamp = Date.now().toString(36);
  const tail = (suffix ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  return [kind, tail, stamp].filter(Boolean).join("-");
}

/**
 * Wraps a job body so the result file always exists once the job ends. The
 * deploy/anchor scripts write their own richer result through `--out`; this
 * only fills in a result when they died before getting that far.
 */
function jobScript(id: string, body: string) {
  const res = `${RUNNER.out}/${id}.json`;
  const cur = `${RUNNER.out}/${id}.cur`;
  return `#!/bin/sh
echo $$ > ${RUNNER.out}/${id}.pid
echo "JOB_START $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
# \`step\` names the command that is about to run, both in the log and in a file,
# so a non-zero exit can say WHAT failed instead of only the status code.
step() { echo "RUNNING $1"; printf %s "$1" > ${cur}; }
step "starting"
# Heartbeat: without it a wedged job and a working job look identical in the log
# tail, so the UI cannot tell "slow" from "dead".
( while true; do sleep 30; echo "HEARTBEAT $(date -u '+%H:%M:%SZ')"; done ) &
hb=$!
( set -e
${body}
)
status=$?
kill $hb 2>/dev/null
if [ ! -f ${res} ]; then
  if [ "$status" = "0" ]; then
    echo '{"ok":true}' > ${res}
  else
    label=$(cat ${cur} 2>/dev/null)
    echo "JOB_FAILED status=$status during: $label"
    printf '{"ok":false,"error":"Failed while %s (exit status %s) — see the runner log."}\\n' "\${label:-running the job}" "$status" > ${res}
  fi
fi
rm -f ${RUNNER.out}/${id}.pid
`;
}


/**
 * Ships the job script as base64 rather than inlining it in the exec command:
 * signed URLs and shell bodies are full of characters that would otherwise need
 * several layers of quoting inside `sh -c`.
 */
async function launchJob(appName: string, machineId: string, id: string, body: string) {
  const b64 = Buffer.from(jobScript(id, body), "utf8").toString("base64");
  const write = await execOnMachine(
    appName,
    machineId,
    `mkdir -p ${JOBS_DIR} ${RUNNER.logs} ${RUNNER.out} ${RUNNER.app} && printf %s ${b64} | base64 -d > ${JOBS_DIR}/${id}.sh`,
  );
  if (write.exitCode !== 0) {
    throw new Error(`Could not write the job script to the runner: ${write.output.slice(0, 300)}`);
  }
  const launch = await execOnMachine(
    appName,
    machineId,
    `cd ${RUNNER.app} && nohup sh ${JOBS_DIR}/${id}.sh > ${RUNNER.logs}/${id}.log 2>&1 & echo launched ${id}`,
  );
  if (launch.exitCode !== 0) {
    throw new Error(`Could not launch the job on the runner: ${launch.output.slice(0, 300)}`);
  }
  return id;
}

const RESULT_MARK = "===RESULT===";
const LOG_MARK = "===LOG===";
const PID_MARK = "===PID===";

/** Reads a job's result file, log tail, and whether its wrapper is still alive. */
export async function readJob(
  appName: string,
  machineId: string,
  id: string,
  tailBytes = 3000,
): Promise<RunnerJob> {
  const out = await execOnMachine(
    appName,
    machineId,
    [
      `echo ${RESULT_MARK}`,
      `cat ${RUNNER.out}/${id}.json 2>/dev/null`,
      `echo ${LOG_MARK}`,
      `tail -c ${tailBytes} ${RUNNER.logs}/${id}.log 2>/dev/null`,

      `echo ${PID_MARK}`,
      // /proc beats pgrep/ps: procps is not installed in the slim Node image.
      `p=$(cat ${RUNNER.out}/${id}.pid 2>/dev/null); if [ -n "$p" ] && [ -d /proc/$p ]; then echo alive; else echo gone; fi`,
    ].join("; "),
  );
  const text = out.output;
  const resultRaw = text.split(RESULT_MARK)[1]?.split(LOG_MARK)[0]?.trim() ?? "";
  const log = text.split(LOG_MARK)[1]?.split(PID_MARK)[0]?.trim() ?? "";
  const alive = (text.split(PID_MARK)[1] ?? "").includes("alive");

  let result: RunnerJobResult | null = null;
  if (resultRaw) {
    try {
      result = JSON.parse(resultRaw) as RunnerJobResult;
    } catch {
      result = { ok: false, error: `Unreadable result file: ${resultRaw.slice(0, 200)}` };
    }
  }

  // A job whose wrapper is gone without a result file did not finish — it was
  // killed (an OOM kill takes the whole machine down and `restart: always`
  // brings it back clean). Reporting that as "still running" is what made the
  // install look like an endless spinner, so name it instead.
  if (!result && !alive && /JOB_START/.test(log)) {
    const events = await machineEventSummary(appName, machineId);
    result = {
      ok: false,
      error:
        "The runner stopped before the job finished — most likely it ran out of memory and restarted." +
        (events ? ` Recent machine events: ${events}.` : "") +
        " Press the button again to retry; work already on the volume is reused.",
    };
  }

  return { id, kind: jobKind(id), running: alive && !result, log, result };
}

/** The most recent job on the volume, so a page refresh re-attaches to it. */
async function latestJob(appName: string, machineId: string): Promise<RunnerJob | null> {
  const out = await execOnMachine(
    appName,
    machineId,
    `ls -1t ${RUNNER.logs}/*.log 2>/dev/null | head -1 | xargs -r basename 2>/dev/null | sed 's/\\.log$//'`,
  );
  const id = out.output.trim().split("\n").pop()?.trim();
  if (!id) return null;
  return readJob(appName, machineId, id);
}

export async function runnerStatus(appPrefix: string): Promise<RunnerStatus> {
  const { appName } = stackUrls(`${appPrefix}-midnight`);
  if (!flyConfigured()) {
    return { configured: false, machine: null, ready: null, current: false, job: null };
  }
  const machine = await findMachineByName(appName, RUNNER.machine);
  if (!machine) {
    return { configured: true, machine: null, ready: null, current: false, job: null };
  }
  // A stopped machine cannot be exec'd into, so report it without probing.
  if (machine.state !== "started") {
    return { configured: true, machine, ready: null, current: false, job: null };
  }
  const ready = await execOnMachine(appName, machine.id, `cat ${RUNNER.work}/.ready 2>/dev/null`);
  const version = ready.output.trim() || null;
  const job = await latestJob(appName, machine.id);
  return {
    configured: true,
    machine,
    ready: version,
    current: version === RUNNER.artifactVersion,
    job,
  };
}

/**
 * Creates the machine if needed and installs the toolchain: the compiled
 * contract and both scripts come from a signed Storage URL, the SDK from npm.
 */
export async function prepareRunner(input: {
  appPrefix: string;
  region: string;
  bundleUrl: string;
}): Promise<{ machine: { id: string; state: string }; jobId: string }> {
  const appName = `${input.appPrefix}-midnight`;
  const machine = await ensureRunnerMachine(appName, input.region);
  if (machine.state !== "started") await startMachine(appName, machine.id);

  const id = newJobId("bootstrap");
  const npm = `npm install --no-audit --no-fund --loglevel=error --prefer-offline --cache ${RUNNER.work}/npm-cache`;
  const body = [
    `echo "installing the Midnight toolchain (this takes a few minutes)"`,
    // The slim Node image usually ships curl; install it only if it is missing.
    `command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl; }`,
    `curl -fsSL "${input.bundleUrl}" -o ${RUNNER.work}/bundle.tgz`,
    // Extracted over the top rather than after `rm -rf`: the bundle only
    // carries scripts and contract artifacts, so keeping node_modules in place
    // makes a retry after a restart reuse everything already installed.
    `mkdir -p ${RUNNER.app} ${RUNNER.work}/npm-cache`,
    `tar xzf ${RUNNER.work}/bundle.tgz -C ${RUNNER.app}`,
    // Plain progress markers so the UI can show a step timeline instead of a log wall.
    `echo STEP:staged`,
    `cd ${RUNNER.app}`,
    // Cap the heap so npm reports a failure instead of being killed silently by
    // the kernel, and install in groups to keep the memory peak down.
    `export NODE_OPTIONS=--max-old-space-size=3072`,
    `echo STEP:deps`,
    ...RUNNER.depGroups.flatMap((group, i) => [
      `echo "installing group ${i + 1} of ${RUNNER.depGroups.length}"`,
      `${npm} ${group.join(" ")}`,
      `echo STEP:deps:${i + 1}`,
    ]),
    `printf %s ${RUNNER.artifactVersion} > ${RUNNER.work}/.ready`,
    `echo BOOTSTRAP_OK`,
  ].join("\n");

  const jobId = await launchJob(appName, machine.id, id, body);
  return { machine, jobId };
}

async function runnerFor(appPrefix: string) {
  const appName = `${appPrefix}-midnight`;
  const machine = await findMachineByName(appName, RUNNER.machine);
  if (!machine) {
    throw new Error("No runner machine on this stack yet — run Prepare runner first.");
  }
  if (machine.state !== "started") await startMachine(appName, machine.id);
  const ready = await execOnMachine(appName, machine.id, `cat ${RUNNER.work}/.ready 2>/dev/null`);
  if (ready.output.trim() !== RUNNER.artifactVersion) {
    throw new Error("The runner's toolchain is missing or out of date — run Prepare runner first.");
  }
  return { appName, machineId: machine.id, urls: stackUrls(appName) };
}

/** Endpoints the scripts dial: indexer GraphQL, proof server, node RPC. */
function endpointArgs(urls: { indexerUrl: string; proofUrl: string; nodeUrl: string }) {
  return `--indexer ${urls.indexerUrl} --proof ${urls.proofUrl} --node ${urls.nodeUrl}`;
}

export async function startDeployJob(appPrefix: string) {
  const { appName, machineId, urls } = await runnerFor(appPrefix);
  const id = newJobId("deploy");
  const body = [
    `cd ${RUNNER.app}`,
    `node scripts/deploy-midnight.mjs ${endpointArgs(urls)} --project ${RUNNER.app} --out ${RUNNER.out}/${id}.json`,
  ].join("\n");
  return { jobId: await launchJob(appName, machineId, id, body), appName };
}

export async function startAnchorJob(input: {
  appPrefix: string;
  commitment: string;
  contractAddress: string;
  anchorId: string;
}) {
  if (!/^[0-9a-f]{64}$/.test(input.commitment)) {
    throw new Error("The commitment must be 64 hex characters.");
  }
  if (!/^[0-9a-f]{64,}$/.test(input.contractAddress)) {
    throw new Error("No deployed contract address — deploy the contract first.");
  }
  const { appName, machineId, urls } = await runnerFor(input.appPrefix);
  const id = newJobId("anchor", input.anchorId.replace(/-/g, ""));
  const body = [
    `cd ${RUNNER.app}`,
    `node scripts/anchor-midnight.mjs ${endpointArgs(urls)} --project ${RUNNER.app}` +
      ` --store ${RUNNER.store} --address ${input.contractAddress}` +
      ` --commitment ${input.commitment} --out ${RUNNER.out}/${id}.json`,
  ].join("\n");
  return { jobId: await launchJob(appName, machineId, id, body), appName };
}

/**
 * Read-only membership proof: asks the contract's own ledger view whether the
 * commitment is in the on-chain Set. This is the only honest answer to "is this
 * summary anchored" — the presence of a transaction hash is not.
 */
export async function startVerifyJob(input: {
  appPrefix: string;
  commitment: string;
  contractAddress: string;
  anchorId: string;
}) {
  if (!/^[0-9a-f]{64}$/.test(input.commitment)) {
    throw new Error("The commitment must be 64 hex characters.");
  }
  if (!/^[0-9a-f]{64,}$/.test(input.contractAddress)) {
    throw new Error("No deployed contract address — deploy the contract first.");
  }
  const { appName, machineId, urls } = await runnerFor(input.appPrefix);
  const id = newJobId("verify", input.anchorId.replace(/-/g, ""));
  const body = [
    `cd ${RUNNER.app}`,
    `node scripts/verify-midnight.mjs ${endpointArgs(urls)} --project ${RUNNER.app}` +
      ` --address ${input.contractAddress} --commitment ${input.commitment}` +
      ` --out ${RUNNER.out}/${id}.json`,
  ].join("\n");
  return { jobId: await launchJob(appName, machineId, id, body), appName };
}


export async function pollJob(appPrefix: string, jobId: string): Promise<RunnerJob> {
  if (!/^[a-z0-9-]+$/.test(jobId)) throw new Error("Invalid job id.");
  const appName = `${appPrefix}-midnight`;
  const machine = await findMachineByName(appName, RUNNER.machine);
  if (!machine) throw new Error("The runner machine no longer exists.");
  return readJob(appName, machine.id, jobId);
}
