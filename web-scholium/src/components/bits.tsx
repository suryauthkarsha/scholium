// Small pieces shared by every screen.
import { AlertTriangle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { errorText } from "@/lib/api";
import { MODELS, type ModelKey } from "@/shared/models";
import { LABEL_NAMES, type Label, type RunStatus } from "@/shared/types";

export const modelColor = (key: ModelKey): string => `hsl(var(${MODELS[key]?.color ?? "--muted-foreground"}))`;

export function ModelTag({ model, full = false, className = "" }: { model: ModelKey; full?: boolean; className?: string }) {
  const spec = MODELS[model];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${className}`} title={spec ? `${spec.label} · ${spec.id} · effort ${spec.effort}` : model}>
      <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: modelColor(model) }} />
      <span>{spec ? (full ? spec.label : spec.short) : model}</span>
    </span>
  );
}

type Tone = "muted" | "live" | "ok" | "warn" | "bad";

const TONE: Record<Tone, string> = {
  muted: "border-border bg-secondary text-muted-foreground",
  live: "border-rubric/40 bg-rubric-soft text-rubric",
  ok: "border-ok/35 bg-ok-soft text-ok",
  warn: "border-warn/40 bg-warn-soft text-warn",
  bad: "border-destructive/40 bg-destructive/10 text-destructive",
};

export const STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "muted" },
  running: { label: "Running", tone: "live" },
  paused: { label: "Paused", tone: "warn" },
  stopped: { label: "Stopped", tone: "muted" },
  completed: { label: "Completed", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  needs_attention: { label: "Needs attention", tone: "warn" },
};

export function Chip({ tone = "muted", children, title, className = "" }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={`chip ${TONE[tone]} ${className}`} title={title}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: RunStatus }) {
  const s = STATUS[status] ?? STATUS.draft;
  return (
    <Chip tone={s.tone}>
      {status === "running" && <span className="live-dot mr-0.5 !h-1.5 !w-1.5" />}
      {s.label}
    </Chip>
  );
}

const LABEL_TONE: Record<Label, Tone> = { conjecture: "muted", numerical: "muted", partial: "warn", candidate: "warn", reviewed: "ok", formal: "ok" };

/** How far a claim has got. The wording never promises more than the label means. */
export function LabelChip({ label }: { label: Label }) {
  return (
    <Chip tone={LABEL_TONE[label] ?? "muted"} className={label === "formal" ? "font-semibold" : ""}>
      {LABEL_NAMES[label] ?? label}
    </Chip>
  );
}

export function Meter({ value, max, mark, tone = "ink" }: { value: number; max: number; mark?: number; tone?: "ink" | "rubric" }) {
  const pct = (n: number): number => (max > 0 ? Math.max(0, Math.min(100, (n / max) * 100)) : 0);
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={Math.round(pct(value))} aria-valuemin={0} aria-valuemax={100}>
      {mark !== undefined && <div className="absolute inset-y-0 left-0 bg-foreground/20" style={{ width: `${pct(mark)}%` }} />}
      <div className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ${tone === "rubric" ? "bg-rubric" : "bg-foreground/75"}`} style={{ width: `${pct(value)}%` }} />
    </div>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return (
    <p className="flex items-center gap-2 py-10 text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> {what}…
    </p>
  );
}

export function ErrorNote({ error, retry, className = "" }: { error: unknown; retry?: () => void; className?: string }) {
  return (
    <div className={`flex items-start gap-2.5 rounded-sm border border-destructive/40 bg-destructive/10 p-3 text-[0.93rem] ${className}`} role="alert">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="break-words">{errorText(error)}</p>
        {retry && (
          <button type="button" onClick={retry} className="mt-1 font-medium underline underline-offset-4">
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="hairline rounded-sm border border-dashed px-6 py-10 text-center">
      <p className="font-serif text-xl">{title}</p>
      {children && <div className="mx-auto mt-1.5 max-w-md text-[0.93rem] leading-relaxed text-muted-foreground">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Section({ title, aside, children, className = "" }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="hairline mb-3 flex items-end justify-between gap-3 border-b pb-1.5">
        <h2 className="rubric">{title}</h2>
        {aside && <div className="text-[0.8rem] text-muted-foreground">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} d ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export const clock = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const usd = (n: number): string => (n >= 100 ? `$${n.toFixed(0)}` : n >= 0.995 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`);
