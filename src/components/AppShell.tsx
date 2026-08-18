import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Cloud,
  FileHeart,
  Github,
  IdCard,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { signOut } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard },
  { to: "/app/deploy", label: "Deploy", icon: Cloud },
  { to: "/app/ips", label: "Summaries", icon: FileHeart },
  { to: "/app/identus", label: "Identus", icon: IdCard },
  { to: "/app/midnight", label: "Midnight", icon: Moon },
  { to: "/app/verify", label: "Verify", icon: ShieldCheck },
  { to: "/app/activity", label: "Activity", icon: Activity },
] as const;

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map(({ to, label, icon: Icon }) => {
        const active = to === "/app" ? pathname === "/app" : pathname.startsWith(to);
        return (
          <Link
            key={to}
            to={to}
            onClick={onNavigate}
            className={cn(
              "group relative flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm transition-all duration-200",
              active
                ? "bg-primary/10 font-medium text-primary shadow-[inset_0_0_0_1px_var(--hairline)]"
                : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary transition-all duration-300",
                active ? "opacity-100" : "h-0 opacity-0",
              )}
            />
            <Icon
              className={cn(
                "h-4 w-4 shrink-0 transition-transform duration-200",
                !active && "group-hover:scale-110",
              )}
            />
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function BrandMark({ size = "md" }: { size?: "sm" | "md" }) {
  return (
    <span
      className={cn(
        "grid place-items-center rounded-xl text-primary-foreground shadow-[var(--shadow-glow)]",
        size === "md" ? "h-9 w-9" : "h-7 w-7",
      )}
      style={{ background: "var(--gradient-primary)" }}
    >
      <Activity className={size === "md" ? "h-4.5 w-4.5" : "h-3.5 w-3.5"} />
    </span>
  );
}

export function AppShell({ children, email }: { children: ReactNode; email?: string | null }) {
  return (
    <div className="flex min-h-screen bg-background">
      <aside className="relative hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-4 lg:flex">
        <div className="pointer-events-none absolute inset-0 grid-backdrop opacity-50" />
        <Link to="/" className="relative mb-7 flex items-center gap-2.5">
          <BrandMark />
          <span className="font-display text-[0.95rem] font-bold tracking-tight">IPS Compass</span>
        </Link>
        <div className="relative">
          <NavLinks />
        </div>
        <div className="relative mt-auto space-y-2 pt-6">
          <a
            href="https://github.com/arunnadarasa/ipsmidnight"
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          >
            <Github className="h-4 w-4 shrink-0" />
            <span className="truncate">View source on GitHub</span>
          </a>
          <div className="rounded-xl border border-sidebar-border bg-card/60 p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              Signed in
            </p>
            <p className="mt-0.5 truncate text-xs font-medium">{email ?? "Clinician"}</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 h-8 w-full justify-start px-2 text-muted-foreground hover:text-foreground"
              onClick={() => void signOut()}
            >
              <LogOut className="mr-2 h-3.5 w-3.5" /> Sign out
            </Button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-border px-3 py-2.5 panel-glass rounded-none shadow-none lg:hidden">
          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                aria-label="Open navigation"
                className="h-10 w-10 shrink-0 rounded-xl"
              >
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[17.5rem] bg-sidebar p-4">
              <SheetTitle className="mb-5 flex items-center gap-2 font-display text-sm font-bold tracking-tight">
                <BrandMark size="sm" />
                IPS Compass
              </SheetTitle>
              <NavLinks />
              <Button
                variant="ghost"
                size="sm"
                className="mt-6 w-full justify-start"
                onClick={() => void signOut()}
              >
                <LogOut className="mr-2 h-4 w-4" /> Sign out
              </Button>
              <a
                href="https://github.com/arunnadarasa/ipsmidnight"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
              >
                <Github className="h-4 w-4 shrink-0" />
                <span className="truncate">View source on GitHub</span>
              </a>
            </SheetContent>
          </Sheet>
          <span className="flex min-w-0 items-center gap-2 truncate font-display text-sm font-bold tracking-tight">
            <BrandMark size="sm" />
            IPS Compass
          </span>
        </header>
        <main className="relative min-w-0 flex-1 px-3 py-5 pb-24 sm:p-6 lg:p-9">
          <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-72 hero-mesh opacity-70" />
          {children}
        </main>
      </div>
    </div>
  );
}
