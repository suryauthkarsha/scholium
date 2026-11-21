// The frame around every signed-in screen: the project sidebar, the month's spending, and the account.
import { useQuery } from "@tanstack/react-query";
import { LogOut, Menu, Plus, Settings2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

import { Meter, STATUS, usd } from "@/components/bits";
import { MathText } from "@/components/Markdown";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useAuth } from "@/hooks/useAuth";
import { api } from "@/lib/api";
import { ThemeToggle } from "@/lib/theme";
import { PHASE_NAMES, type RunSummary } from "@/shared/types";

export function useWorkspace() {
  return useQuery({ queryKey: ["workspace"], queryFn: ({ signal }) => api.workspace(signal), refetchInterval: 20_000, staleTime: 5_000 });
}

const DOT: Record<string, string> = { muted: "bg-muted-foreground/45", live: "bg-rubric", ok: "bg-ok", warn: "bg-warn", bad: "bg-destructive" };

function RunLink({ run, onNavigate }: { run: RunSummary; onNavigate?: () => void }) {
  const s = STATUS[run.status] ?? STATUS.draft;
  return (
    <NavLink
      to={`/r/${run.id}`}
      onClick={onNavigate}
      className={({ isActive }) => `group relative block rounded-sm py-2 pl-6 pr-2 transition-colors ${isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"}`}
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute inset-y-1.5 left-0 w-[2px] bg-rubric" />}
          <span className={`absolute left-2 top-[0.95rem] h-2 w-2 rounded-full ${run.status === "running" ? "live-dot" : DOT[s.tone]}`} title={s.label} />
          <span className="block truncate font-serif text-[1.02rem] leading-tight"><MathText text={run.title || run.goal || "Untitled project"} /></span>
          <span className="mt-0.5 block truncate text-[0.74rem] text-muted-foreground">
            {s.label} · {PHASE_NAMES[run.phase] ?? run.phase}
            {run.cycle > 1 ? ` · cycle ${run.cycle}` : ""} · {usd(run.spendUsd)}
          </span>
        </>
      )}
    </NavLink>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { access, signOut } = useAuth();
  const ws = useWorkspace();
  const runs = [...(ws.data?.runs ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  const budget = ws.data?.budget;
  const usage = ws.data?.usage;
  const me = access.state === "allowed" ? access : null;

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <Link to="/" onClick={onNavigate} className="flex items-center gap-2.5">
          <img src="/icon.png" alt="" className="h-7 w-7 rounded-[6px]" />
          <span className="font-serif text-[1.3rem] leading-none">Scholium</span>
        </Link>
        <ThemeToggle />
      </div>

      <div className="px-3">
        <Link to="/new" onClick={onNavigate} className="press flex h-9 items-center justify-center gap-1.5 rounded-sm bg-primary text-[0.93rem] font-medium text-primary-foreground">
          <Plus className="h-4 w-4" /> New project
        </Link>
      </div>

      <div className="mt-5 flex items-baseline justify-between px-4">
        <span className="rubric">Projects</span>
        <span className="tabular text-[0.74rem] text-muted-foreground">{ws.data ? runs.length : ""}</span>
      </div>
      <nav className="mt-1.5 min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-3">
        {ws.isLoading && <p className="px-2 py-3 text-[0.86rem] text-muted-foreground">Loading…</p>}
        {ws.isError && !ws.data && <p className="px-2 py-3 text-[0.86rem] text-destructive">The project list could not be loaded.</p>}
        {ws.data && runs.length === 0 && <p className="px-2 py-3 text-[0.86rem] leading-relaxed text-muted-foreground">No projects yet. Start one and it will stay here, with its whole record.</p>}
        {runs.map((r) => (
          <RunLink key={r.id} run={r} onNavigate={onNavigate} />
        ))}
      </nav>

      {budget && (
        <Link to="/settings" onClick={onNavigate} className="mx-3 mb-2 block rounded-sm border bg-card/60 p-2.5 transition-colors hover:bg-card">
          <div className="flex items-baseline justify-between text-[0.74rem]">
            <span className="eyebrow">Model spend, {budget.month}</span>
            <span className="tabular">
              {usd(budget.spentUsd)} <span className="text-muted-foreground">of {usd(budget.capUsd)}</span>
            </span>
          </div>
          <div className="mt-1.5">
            <Meter value={budget.spentUsd} mark={budget.committedUsd} max={budget.capUsd} tone={budget.availableUsd <= 0 ? "rubric" : "ink"} />
          </div>
          {usage?.blocked && <p className="mt-1.5 text-[0.74rem] leading-snug text-rubric">{usage.blocked}</p>}
        </Link>
      )}

      <div className="hairline flex items-center gap-2 border-t px-3 py-2.5">
        {me?.picture ? (
          <img src={me.picture} alt="" referrerPolicy="no-referrer" className="h-7 w-7 rounded-full" />
        ) : (
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-secondary font-serif">{(me?.email ?? "?").slice(0, 1).toUpperCase()}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-[0.8rem]" title={me?.email}>
          {me?.email}
        </span>
        <Link to="/settings" onClick={onNavigate} aria-label="Settings" title="Settings" className="press flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground">
          <Settings2 className="h-4 w-4" />
        </Link>
        <button type="button" onClick={signOut} aria-label="Sign out" title="Sign out" className="press flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground">
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default function Shell() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="no-print hidden w-[17.5rem] shrink-0 border-r border-sidebar-border md:block">
        <Sidebar />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex h-12 shrink-0 items-center gap-2 border-b px-3 md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <button type="button" aria-label="Open the project list" className="press flex h-9 w-9 items-center justify-center rounded-sm border bg-card">
                <Menu className="h-4 w-4" />
              </button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[19rem] p-0">
              <SheetTitle className="sr-only">Projects</SheetTitle>
              <Sidebar onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <Link to="/" className="font-serif text-lg">
            Scholium
          </Link>
        </header>
        <main key={location.pathname.startsWith("/r/") ? location.pathname : "page"} className="print-root min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** A plain scrolling page with a heading, used by every screen except the run view. */
export function Page({ eyebrow, title, actions, children, wide = false }: { eyebrow?: string; title: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={`mx-auto px-5 pb-20 pt-8 sm:px-10 sm:pt-12 ${wide ? "max-w-6xl" : "max-w-4xl"}`}>
        <div className="rise mb-8 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            {eyebrow && <p className="rubric mb-2">{eyebrow}</p>}
            <h1 className="text-[2.2rem] font-normal leading-[1.08] sm:text-[2.6rem]">{title}</h1>
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}
