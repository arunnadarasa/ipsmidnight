import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Activity, Cloud, FileHeart, IdCard, LayoutDashboard, LogOut, Menu, Moon, ShieldCheck } from "lucide-react";
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
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({ children, email }: { children: ReactNode; email?: string | null }) {
  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-4 lg:flex">
        <Link to="/" className="mb-6 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-primary font-display text-sm font-bold text-primary-foreground">
            IPS
          </span>
          <span className="font-display text-sm font-semibold">IPS Console</span>
        </Link>
        <NavLinks />
        <div className="mt-auto space-y-2 pt-6">
          <p className="truncate px-3 text-xs text-muted-foreground">{email ?? "Signed in"}</p>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => void signOut()}>
            <LogOut className="mr-2 h-4 w-4" /> Sign out
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-4 py-3 lg:hidden">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Open navigation">
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 bg-sidebar p-4">
              <SheetTitle className="mb-4 font-display text-sm">IPS Console</SheetTitle>
              <NavLinks />
              <Button variant="ghost" size="sm" className="mt-6 w-full justify-start" onClick={() => void signOut()}>
                <LogOut className="mr-2 h-4 w-4" /> Sign out
              </Button>
            </SheetContent>
          </Sheet>
          <span className="min-w-0 truncate font-display text-sm font-semibold">IPS Console</span>
        </header>
        <main className="min-w-0 flex-1 p-4 pb-24 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
