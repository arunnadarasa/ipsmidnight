import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/auth")({
  validateSearch: (search: Record<string, unknown>) => ({
    next: typeof search["next"] === "string" ? (search["next"] as string) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Sign in — IPS Console" },
      {
        name: "description",
        content: "Sign in to build, credential, and anchor International Patient Summaries.",
      },
      { property: "og:title", content: "Sign in — IPS Console" },
      { property: "og:description", content: "Access your verifiable patient summary workspace." },
    ],
  }),
  component: AuthPage,
});

function safeNext(next: string | undefined) {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/app";
  return next;
}

function AuthPage() {
  const { next } = useSearch({ from: "/auth" });
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<null | "in" | "up" | "google">(null);
  const target = safeNext(next);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) void navigate({ to: target, replace: true });
    });
  }, [navigate, target]);

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("in");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    void navigate({ to: target, replace: true });
  };

  const signUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("up");
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}${target}` },
    });
    setBusy(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Account created — you're signed in.");
    void navigate({ to: target, replace: true });
  };

  const google = async () => {
    setBusy("google");
    sessionStorage.setItem("ips:next", target);
    const result = await lovable.auth.signInWithOAuth("google", {
      redirect_uri: window.location.origin,
    });
    if (result.error) {
      setBusy(null);
      toast.error("Google sign-in failed. Try email instead.");
      return;
    }
    if (result.redirected) return;
    void navigate({ to: target, replace: true });
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-sidebar p-10 lg:flex">
        <div className="pointer-events-none absolute inset-0 hero-mesh" />
        <div className="pointer-events-none absolute inset-0 grid-backdrop opacity-60" />
        <Link
          to="/"
          className="relative font-display text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          ← IPS Compass
        </Link>
        <div className="relative max-w-sm">
          <h2 className="font-display text-[2.1rem] font-bold leading-[1.15] tracking-tight">
            Patient summaries that travel with{" "}
            <span className="text-gradient">proof, not with data.</span>
          </h2>
          <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
            Compose an IPS FHIR bundle, issue it as an Identus verifiable credential, and anchor only
            a commitment on the Midnight Undeployed network. Clinical content never leaves your
            workspace.
          </p>
        </div>
        <p className="relative font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          Identus 1.40 · Compact 0.23 · Midnight Undeployed
        </p>
      </div>

      <div className="relative flex items-center justify-center p-6">
        <div className="pointer-events-none absolute inset-0 hero-mesh opacity-60 lg:hidden" />
        <div className="panel relative w-full max-w-sm p-6 sm:p-7">
          <h1 className="font-display text-2xl font-bold tracking-tight">Sign in</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Use email and password, or continue with Google.
          </p>

          <Button variant="outline" className="mt-6 w-full" onClick={() => void google()} disabled={busy !== null}>
            {busy === "google" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Continue with Google
          </Button>

          <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
          </div>

          <Tabs defaultValue="signin">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="signin">Sign in</TabsTrigger>
              <TabsTrigger value="signup">Create account</TabsTrigger>
            </TabsList>

            {(["signin", "signup"] as const).map((tab) => (
              <TabsContent key={tab} value={tab}>
                <form className="space-y-4" onSubmit={tab === "signin" ? signIn : signUp}>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${tab}-email`}>Email</Label>
                    <Input
                      id={`${tab}-email`}
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${tab}-password`}>Password</Label>
                    <Input
                      id={`${tab}-password`}
                      type="password"
                      autoComplete={tab === "signin" ? "current-password" : "new-password"}
                      required
                      minLength={6}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={busy !== null}>
                    {busy === (tab === "signin" ? "in" : "up") ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    {tab === "signin" ? "Sign in" : "Create account"}
                  </Button>
                </form>
              </TabsContent>
            ))}
          </Tabs>
        </div>
      </div>
    </div>
  );
}
