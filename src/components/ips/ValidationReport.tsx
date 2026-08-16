import { AlertTriangle, CheckCircle2, CircleDashed, Info, XCircle } from "lucide-react";
import type { ValidationResult } from "@/lib/ips/types";
import { Badge } from "@/components/ui/badge";

export function ValidationReport({ result }: { result: ValidationResult }) {
  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {result.ok ? (
          <Badge className="bg-success/15 text-success">
            <CheckCircle2 className="mr-1 h-3 w-3" /> Structurally valid IPS
          </Badge>
        ) : (
          <Badge className="bg-destructive/15 text-destructive">
            <XCircle className="mr-1 h-3 w-3" /> {errors.length} blocking issue
            {errors.length === 1 ? "" : "s"}
          </Badge>
        )}
        {warnings.length > 0 ? (
          <Badge className="bg-warning/15 text-warning">
            <AlertTriangle className="mr-1 h-3 w-3" /> {warnings.length} warning
            {warnings.length === 1 ? "" : "s"}
          </Badge>
        ) : null}
      </div>

      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Patient", value: result.patient.name ?? "—" },
          { label: "Date of birth", value: result.patient.birthDate ?? "—" },
          { label: "Gender", value: result.patient.gender ?? "—" },
          { label: "Resources", value: String(Object.values(result.resourceCounts).reduce((a, b) => a + b, 0)) },
        ].map((item) => (
          <div key={item.label} className="rounded-lg border border-border bg-card/60 p-3">
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className="mt-0.5 truncate text-sm font-medium">{item.value}</dd>
          </div>
        ))}
      </dl>

      <ul className="grid gap-2 sm:grid-cols-2">
        {result.sections.map((s) => (
          <li
            key={s.key}
            className="flex items-center justify-between gap-2 rounded-md border border-border bg-card/40 px-3 py-2 text-sm"
          >
            <span className="flex min-w-0 items-center gap-2">
              {s.present ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
              ) : s.required ? (
                <XCircle className="h-4 w-4 shrink-0 text-destructive" />
              ) : (
                <CircleDashed className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{s.title}</span>
            </span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {s.count} {s.required ? "· required" : ""}
            </span>
          </li>
        ))}
      </ul>

      {result.issues.length > 0 ? (
        <ul className="space-y-1.5">
          {result.issues.map((issue, i) => (
            <li key={`${issue.path}-${i}`} className="flex gap-2 text-sm">
              {issue.severity === "error" ? (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              ) : issue.severity === "warning" ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              ) : (
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0">
                <code className="font-mono text-xs text-muted-foreground">{issue.path}</code>{" "}
                <span className="text-foreground/90">{issue.message}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
