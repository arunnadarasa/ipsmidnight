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
        className="min-w-0 truncate rounded-md border border-border/60 bg-secondary/60 px-1.5 py-0.5 font-mono text-xs text-foreground/90"
      >
        {shortenId(value, head, tail)}
      </code>
      {value ? (
        <button
          type="button"
          onClick={copy}
          aria-label="Copy value"
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-all hover:bg-secondary hover:text-primary active:scale-90"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      ) : null}
    </span>
  );
}

export function StatusDot({
  status,
  size = "sm",
}: {
  status: "ok" | "pending" | "error" | "idle";
  size?: "sm" | "md";
}) {
  const tone =
    status === "ok"
      ? "bg-success text-success"
      : status === "error"
        ? "bg-destructive text-destructive"
        : status === "pending"
          ? "bg-warning text-warning"
          : "bg-muted-foreground/50 text-muted-foreground";
  return (
    <span
      className={cn(
        "relative inline-block shrink-0 rounded-full",
        size === "md" ? "h-2.5 w-2.5" : "h-2 w-2",
        tone,
        (status === "ok" || status === "pending") && "pulse-ring",
      )}
      aria-hidden
    />
  );
}
