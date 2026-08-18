import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Activity,
  CheckCircle2,
  FileHeart,
  Fingerprint,
  Github,
  Lock,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { Reveal } from "@/components/Reveal";
import { EcgTrace } from "@/components/EcgTrace";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "IPS Compass — verifiable International Patient Summaries" },
      {
        name: "description",
        content:
          "Compose, validate and credential International Patient Summaries, then anchor privacy-preserving commitments on the Midnight Undeployed network.",
      },
      {
        property: "og:title",
        content: "IPS Compass — verifiable International Patient Summaries",
      },
      {
        property: "og:description",
        content:
          "FHIR IPS builder, Identus credentials, and Midnight anchoring in one clinical console.",
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
    body: "Issue a verifiable credential that carries the summary digest and an over-18 flag — never the clinical content.",
  },
  {
    icon: Lock,
    title: "Anchor on Midnight",
    body: "A salted commitment goes on the Undeployed ledger through a Compact circuit and a Fly-hosted proof server.",
  },
  {
    icon: ShieldCheck,
    title: "Verify honestly",
    body: "Recompute the digest, recompute the commitment from its salt, and prove ledger membership. Unperformed checks say so.",
  },
];

const FLOW = [
  {
    step: "01",
    label: "Digest",
    body: "The IPS bundle is canonicalised and hashed. The bundle itself never leaves your database.",
  },
  {
    step: "02",
    label: "Credential",
    body: "Identus issues a verifiable credential over the digest — minimal claims by design.",
  },
  {
    step: "03",
    label: "Anchor",
    body: "A salted commitment is proved and inserted into the IpsAnchorRegistry set on Midnight.",
  },
];

const TRUST = [
  "Clinical content stays server-side, behind row-level security",
  "Credentials carry a digest and an over-18 flag — no name, no date of birth",
  "Anchors are confirmed by ledger membership, never by a bare transaction hash",
  "Checks the console cannot perform are reported as “not checked”, never as green",
];

function Landing() {
  const { session, loading } = useAuth();

  return (
    <main className="min-h-screen overflow-x-hidden bg-background">
      {/* ---------------- Hero ---------------- */}
      <section className="relative isolate overflow-hidden">
        <div className="pointer-events-none absolute inset-0 -z-10 hero-mesh" />
        <div className="pointer-events-none absolute inset-0 -z-10 grid-backdrop opacity-60 [mask-image:radial-gradient(70%_60%_at_50%_0%,black,transparent)]" />
        <div className="pointer-events-none absolute inset-x-0 top-[36%] -z-10 h-40 text-primary/45">
          <EcgTrace />
        </div>

        <header className="relative mx-auto flex max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
          <span className="flex items-center gap-2 font-display text-sm font-semibold tracking-tight">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-primary text-primary-foreground shadow-[var(--shadow-glow)]">
              <Activity className="h-4 w-4" />
            </span>
            IPS Compass
          </span>
          <nav className="flex items-center gap-1.5">
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <a
                href="https://github.com/arunnadarasa/ipsmidnight"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Github className="mr-1.5 h-4 w-4" />
                Source
              </a>
            </Button>
            <Button asChild size="sm" className="sheen">
              <Link to={session ? "/app" : "/auth"}>{session ? "Console" : "Sign in"}</Link>
            </Button>
          </nav>
        </header>

        <div className="relative mx-auto grid max-w-6xl gap-12 px-5 pb-20 pt-10 sm:px-8 sm:pb-28 sm:pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-primary shadow-[var(--shadow-soft)] backdrop-blur">
              <Sparkles className="h-3.5 w-3.5" />
              HL7 FHIR IPS · Identus · Midnight
            </span>
            <h1 className="mt-6 font-display text-[2.6rem] font-extrabold leading-[1.03] tracking-tight sm:text-6xl">
              <span className="text-gradient">Portable patient summaries,</span>
              <br />
              provable without exposing the record.
            </h1>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              Build an IPS bundle, issue a verifiable credential over its digest, and anchor a
              privacy-preserving commitment on the Midnight Undeployed network — the clinical record
              never leaves your own database.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="sheen group h-12 px-6 text-base">
                <Link to={session ? "/app" : "/auth"}>
                  {loading ? "Loading…" : session ? "Open the console" : "Sign in to start"}
                  <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="h-12 border-border bg-card/70 px-6 text-base backdrop-blur"
              >
                <Link to="/app/ips">Explore the IPS workspace</Link>
              </Button>
            </div>
            <dl className="mt-12 grid max-w-lg grid-cols-3 gap-4 border-t border-border pt-6">
              {[
                ["Sections", "IPS-profiled"],
                ["Claims", "Digest only"],
                ["Anchor", "ZK commitment"],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    {k}
                  </dt>
                  <dd className="mt-1 font-display text-sm font-semibold">{v}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Floating console preview */}
          <div className="relative">
            <div className="animate-float panel-glass edge-top p-5 sm:p-6">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                  Anchor lifecycle
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-success/12 px-2.5 py-1 text-[11px] font-medium text-success">
                  <span className="relative grid h-1.5 w-1.5 place-items-center rounded-full bg-success pulse-ring" />
                  confirmed
                </span>
              </div>
              <ol className="mt-5 space-y-3.5">
                {[
                  ["Bundle validated", "12 resources · 6 sections"],
                  ["Digest computed", "sha256:9f4c…a2e2"],
                  ["Credential issued", "did:prism:8b1c…"],
                  ["Commitment anchored", "block #397"],
                  ["Ledger membership", "commitments.member → true"],
                ].map(([label, meta], i) => (
                  <li key={label} className="flex items-start gap-3">
                    <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/12 text-primary">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium leading-tight">{label}</span>
                      <span className="mt-0.5 block break-anywhere font-mono text-[11px] text-muted-foreground">
                        {meta}
                      </span>
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      0{i + 1}
                    </span>
                  </li>
                ))}
              </ol>
              <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full"
                  style={{ width: "100%", background: "var(--gradient-primary)" }}
                />
              </div>
            </div>
            <div
              className="pointer-events-none absolute -inset-6 -z-10 rounded-[2rem] opacity-70 blur-2xl"
              style={{ background: "var(--gradient-hero)" }}
            />
          </div>
        </div>
      </section>

      {/* ---------------- Pillars ---------------- */}
      <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <Reveal>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-primary">
            What the console does
          </p>
          <h2 className="mt-3 max-w-2xl font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Four surfaces, one chain of custody.
          </h2>
        </Reveal>
        <ul className="mt-10 grid gap-5 sm:grid-cols-2">
          {PILLARS.map((p, i) => (
            <Reveal as="li" key={p.title} delay={i * 90}>
              <div className="panel hover-lift edge-top h-full p-6">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
                  <p.icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 font-display text-lg font-semibold tracking-tight">{p.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
              </div>
            </Reveal>
          ))}
        </ul>
      </section>

      {/* ---------------- Flow ---------------- */}
      <section className="relative overflow-hidden border-y border-border bg-secondary/40">
        <div className="pointer-events-none absolute inset-0 grid-backdrop opacity-70" />
        <div className="relative mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
          <Reveal>
            <h2 className="max-w-2xl font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Digest → credential → anchor
            </h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">
              Each hop carries strictly less information than the last. By the time anything reaches a
              public ledger, all that remains is a salted commitment.
            </p>
          </Reveal>
          <ol className="mt-12 grid gap-5 md:grid-cols-3">
            {FLOW.map((f, i) => (
              <Reveal as="li" key={f.step} delay={i * 110}>
                <div className="panel hover-lift relative h-full overflow-hidden p-6">
                  <span className="font-mono text-5xl font-semibold leading-none text-primary/15">
                    {f.step}
                  </span>
                  <h3 className="mt-3 font-display text-lg font-semibold tracking-tight">
                    {f.label}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
                  <span
                    className="absolute inset-x-0 bottom-0 h-1"
                    style={{ background: "var(--gradient-primary)" }}
                  />
                </div>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* ---------------- Trust ---------------- */}
      <section className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
        <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
          <Reveal>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-primary">
              Trust model
            </p>
            <h2 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Honest about what is proved.
            </h2>
            <p className="mt-4 text-muted-foreground">
              This console does not verify issuer signatures, resolve DIDs externally, or check
              revocation status — and it says so in the interface rather than showing a green tick.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <ul className="panel divide-y divide-border overflow-hidden">
              {TRUST.map((t) => (
                <li key={t} className="flex items-start gap-3 p-5">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span className="text-sm leading-relaxed">{t}</span>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </section>

      {/* ---------------- Footer ---------------- */}
      <footer className="border-t border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-12 sm:px-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <span className="flex items-center gap-2 font-display text-sm font-semibold tracking-tight">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary text-primary-foreground">
                <Activity className="h-3.5 w-3.5" />
              </span>
              IPS Compass
            </span>
            <p className="mt-3 max-w-md text-xs leading-relaxed text-muted-foreground">
              Demonstration software running against the Midnight Undeployed dev network. Not a
              certified medical device or clinical record system, and not for real patient data.
            </p>
          </div>
          <a
            href="https://github.com/arunnadarasa/ipsmidnight"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
          >
            <Github className="h-4 w-4" />
            arunnadarasa/ipsmidnight
          </a>
        </div>
      </footer>
    </main>
  );
}
