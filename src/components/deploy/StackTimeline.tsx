import { useEffect, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Circle, Copy, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatElapsed, stepProgress, type StackStep } from "@/lib/stack-steps";

function useTicker(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [active]);
}

export function StackTimeline({
  steps,
  startedAt,
  readyAt,
  regionLabel,
  onRetry,
  retrying,
}: {
  steps: StackStep[];
  startedAt: string | null;
  readyAt?: string | null;
  regionLabel?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const { done, total, allDone, failed } = stepProgress(steps);
  useTicker(!allDone);
  const [expanded, setExpanded] = useState(false);

  const start = startedAt ? new Date(startedAt).getTime() : null;
  const elapsedMs = start ? (readyAt ? new Date(readyAt).getTime() : Date.now()) - start : null;
  const elapsed = elapsedMs != null ? formatElapsed(elapsedMs) : null;

  const collapsed = allDone && !expanded;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-xs text-muted-foreground">
          {allDone ? (
            <span className="text-success">Stack ready{elapsed ? ` in ${elapsed}` : ""}</span>
          ) : (
            <>
              {done} of {total} steps complete
              {regionLabel ? <> · {regionLabel}</> : null}
            </>
          )}
        </p>
        <div className="flex items-center gap-2 sm:shrink-0">
          {!allDone && elapsed ? (
            <span className="font-mono text-[11px] text-muted-foreground">{elapsed} elapsed</span>
          ) : null}
          {allDone ? (
            <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)} className="h-7 px-2 text-xs">
              <ChevronDown className={"mr-1 h-3.5 w-3.5 transition-transform " + (expanded ? "rotate-180" : "")} />
              {expanded ? "Hide steps" : "Show steps"}
            </Button>
          ) : null}
        </div>
      </div>

      {!allDone ? (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary shadow-[inset_0_0_0_1px_var(--hairline)]">
          <div
            className={
              "relative h-full rounded-full transition-all duration-700 ease-out " +
              (failed ? "bg-destructive" : "sheen")
            }
            style={{
              width: `${Math.round((done / Math.max(1, total)) * 100)}%`,
              background: failed ? undefined : "var(--gradient-primary)",
            }}
          />
        </div>
      ) : null}

      {collapsed ? null : (
        <ol className="relative space-y-2.5 pl-1">
          <span
            className="pointer-events-none absolute bottom-3 left-[10px] top-3 w-px bg-border"
            aria-hidden
          />
          {steps.map((step) => (
            <li key={step.key} className="relative flex items-start gap-3">
              <span
                className={
                  "relative z-10 mt-px grid h-[19px] w-[19px] shrink-0 place-items-center rounded-full border transition-colors " +
                  (step.state === "done"
                    ? "border-success/40 bg-success/12 text-success"
                    : step.state === "failed"
                      ? "border-destructive/40 bg-destructive/12 text-destructive"
                      : step.state === "active"
                        ? "border-primary/40 bg-primary/12 text-primary pulse-ring"
                        : "border-border bg-card text-muted-foreground/40")
                }
              >
                {step.state === "done" ? (
                  <Check className="h-3 w-3" />
                ) : step.state === "failed" ? (
                  <AlertTriangle className="h-3 w-3" />
                ) : step.state === "active" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Circle className="h-2 w-2" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span
                    className={
                      "text-xs " +
                      (step.state === "pending"
                        ? "text-muted-foreground/60"
                        : step.state === "failed"
                          ? "text-destructive"
                          : step.state === "active"
                            ? "text-foreground"
                            : "text-muted-foreground")
                    }
                  >
                    {step.label}
                  </span>
                  {step.value ? (
                    <span className="break-anywhere font-mono text-[11px] text-muted-foreground">{step.value}</span>
                  ) : null}
                </span>
                {step.state === "active" && step.hint ? (
                  <span className="mt-0.5 block text-[11px] text-muted-foreground/70">{step.hint}</span>
                ) : null}
                {step.state === "failed" && step.detail ? (
                  <span className="mt-1 block rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1">
                    <span className="block max-h-40 overflow-y-auto break-anywhere whitespace-pre-wrap font-mono text-[11px] text-destructive">
                      {step.detail}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-1 h-6 px-1.5 text-[11px] text-destructive hover:text-destructive"
                      onClick={() => navigator.clipboard?.writeText(step.detail ?? "")}
                    >
                      <Copy className="mr-1 h-3 w-3" />
                      Copy error
                    </Button>
                  </span>
                ) : null}

                {step.state === "active" && step.detail ? (
                  <span className="mt-0.5 block break-anywhere text-[11px] text-muted-foreground/70">
                    {step.detail}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      )}

      {failed && onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying} className="w-full sm:w-auto">
          {retrying ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          )}
          Retry check
        </Button>
      ) : null}
    </div>
  );
}
