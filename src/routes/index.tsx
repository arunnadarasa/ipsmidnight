import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, FileHeart, Fingerprint, Lock, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "IPS Console — verifiable International Patient Summaries" },
      {
        name: "description",
        content:
          "Compose, validate and credential International Patient Summaries, then anchor privacy-preserving commitments on the Midnight Undeployed network.",
      },
      { property: "og:title", content: "IPS Console — verifiable International Patient Summaries" },
      {
        property: "og:description",
        content: "FHIR IPS builder, Identus credentials, and Midnight anchoring in one clinical console.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const PILLARS = [
  {
    icon: FileHeart,
    title: "Compose & validate",
    body: "A guided FHIR builder plus raw upload, checked against the IPS section profile before anything leaves the page.",
  },
  {
    icon: Fingerprint,
    title: "Credential with Identus",
    body: "Issue a verifiable credential that carries the summary digest — never the clinical content.",
  },
  {
    icon: Lock,
    title: "Anchor on Midnight",
    body: "A salted commitment goes on the Undeployed ledger through a Compact circuit and a Fly-hosted proof server.",
  },
  {
    icon: ShieldCheck,
    title: "Verify anywhere",
    body: "Recompute the digest, match the credential, and confirm the anchor against the indexer.",
  },
];

function Landing() {
  const { session, loading } = useAuth();

  return (
    <main className="min-h-screen bg-background">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(60%_100%_at_50%_0%,hsl(var(--primary)/0.18),transparent)]" />
      <div className="relative mx-auto max-w-5xl px-6 py-20 sm:py-28">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
          International Patient Summary
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
          Portable patient summaries, provable without exposing the record.
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-muted-foreground">
          Build an IPS bundle, issue a verifiable credential over its digest, and anchor a
          privacy-preserving commitment on the Midnight Undeployed network — clinical content stays in
          your own database.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link to={session ? "/app" : "/auth"}>
              {loading ? "Loading…" : session ? "Open the console" : "Sign in to start"}
              <ArrowRight className="ml-1.5 h-4 w-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/app/ips">Explore the IPS workspace</Link>
          </Button>
        </div>

        <ul className="mt-16 grid gap-4 sm:grid-cols-2">
          {PILLARS.map((p) => (
            <li key={p.title} className="rounded-lg border border-border bg-card/50 p-5">
              <p.icon className="h-5 w-5 text-primary" />
              <h2 className="mt-3 text-base font-medium">{p.title}</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">{p.body}</p>
            </li>
          ))}
        </ul>

        <p className="mt-14 text-xs text-muted-foreground">
          Demonstration software. Not a certified medical device or clinical record system.
        </p>
      </div>
    </main>
  );
}
