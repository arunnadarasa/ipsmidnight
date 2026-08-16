import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { shortenId } from "@/lib/ips/digest";
import { cn } from "@/lib/utils";

export { shortenId };

type Props = {
  value: string | null | undefined;
  label?: string;
  head?: number;
  tail?: number;
  className?: string;
};

export function TruncatedMono({ value, label, head = 10, tail = 6, className }: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1.5", className)}>
      {label ? <span className="shrink-0 text-xs text-muted-foreground">{label}</span> : null}
      <code
        title={value ?? undefined}
        className="min-w-0 truncate rounded bg-secondary/70 px-1.5 py-0.5 font-mono text-xs text-foreground/90"
      >
        {shortenId(value, head, tail)}
      </code>
      {value ? (
        <button
          type="button"
          onClick={copy}
          aria-label="Copy value"
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      ) : null}
    </span>
  );
}

export function StatusDot({ status }: { status: "ok" | "pending" | "error" | "idle" }) {
  const tone =
    status === "ok"
      ? "bg-success"
      : status === "error"
        ? "bg-destructive"
        : status === "pending"
          ? "bg-warning animate-pulse"
          : "bg-muted-foreground/50";
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", tone)} aria-hidden />;
}
