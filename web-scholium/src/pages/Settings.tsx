// Workspace settings: the spending ceiling, the outside services, connection checks, method notes and the session.
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Loader2, LogOut, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Chip, ErrorNote, Loading, Meter, ModelTag, Section, timeAgo, usd } from "@/components/bits";
import { Field } from "@/components/ConfigForm";
import Methods from "@/components/Methods";
import { Page, useWorkspace } from "@/components/Shell";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/useAuth";
import { api, errorText, type SettingsPatch } from "@/lib/api";
import { ThemeToggle } from "@/lib/theme";
import type { UsageView } from "@/shared/budget";
import { MODEL_KEYS, MODELS, type ModelKey } from "@/shared/models";
import type { DiagnosticResult, PublicSettings, WorkspaceOverview } from "@/shared/types";

const BTN = "press flex h-9 shrink-0 items-center gap-1.5 rounded-sm border bg-background px-3 text-sm hover:border-foreground/50 disabled:opacity-50";
type Save = (patch: SettingsPatch, done: string) => Promise<boolean>;

function Item({ title, state, children }: { title: string; state?: ReactNode; children: ReactNode }) {
  return (
    <div className="border-t py-5 first:border-t-0 first:pt-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{title}</h3>
        {state}
      </div>
      <div className="space-y-3 text-sm">{children}</div>
    </div>
  );
}

function Spending({ d, save, busy }: { d: WorkspaceOverview; save: Save; busy: boolean }) {
  const b = d.budget;
  const [cap, setCap] = useState(String(b.capUsd));
  const n = Number(cap);
  return (
    <div className="space-y-4 text-sm">
      <Meter value={b.spentUsd} mark={b.committedUsd} max={b.capUsd} tone="rubric" />
      <p>
        <span className="tabular font-medium">{usd(b.spentUsd)}</span> spent on model calls in {b.month}, <span className="tabular">{usd(Math.max(0, b.committedUsd - b.spentUsd))}</span> more set aside for projects that are running, <span className="tabular">{usd(Math.max(0, b.availableUsd))}</span> free
        under the ceiling. Connection checks and method tests account for {usd(b.diagUsd)} of the spend.
      </p>
      <div className="flex max-w-md items-end gap-2">
        <Field label="Monthly ceiling (USD)">
          <Input aria-label="Monthly ceiling in dollars" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
        </Field>
        <button type="button" className={BTN} disabled={busy || !Number.isFinite(n) || n < 0 || n === b.capUsd} onClick={() => void save({ monthlyCapUsd: n }, "Ceiling saved")}>
          Save
        </button>
      </div>
      <p className="max-w-2xl text-muted-foreground">
        A run cannot start or continue once it would take the month past this ceiling. Model calls are paid from the credits already included in your Rork plan. Scholium cannot buy credits, change the plan or switch on billing; this ceiling is its own stop.
      </p>
    </div>
  );
}

function Allowance({ u }: { u: UsageView }) {
  const rows: [string, number, number][] = [
    ["Records written", u.written, u.allowance.written],
    ["Records read", u.read, u.allowance.read],
    ["Requests", u.calls, u.allowance.calls],
  ];
  return (
    <div className="space-y-4 text-sm">
      <div className="grid gap-4 sm:grid-cols-3">
        {rows.map(([label, n, max]) => (
          <div key={label}>
            <p className="eyebrow">{label}</p>
            <p className="tabular mb-1">
              {n.toLocaleString()} <span className="text-muted-foreground">/ {max.toLocaleString()}</span>
            </p>
            <Meter value={n} max={max} />
          </div>
        ))}
      </div>
      {u.blocked && <p className="gloss">{u.blocked}</p>}
      <p className="max-w-2xl text-muted-foreground">
        The server's storage has a free daily allowance ({u.day}, UTC). Runs are paused at {Math.round(u.pauseAt * 100)}% of it and can be resumed the next day. The allowance is a limit, not a bill: past it the server refuses work until the next day. Today: {u.takes.email} of {u.takes.caps.email} emails, {u.takes.drive} of{" "}
        {u.takes.caps.drive} Drive uploads.
      </p>
    </div>
  );
}

function Exa({ s, save, busy }: { s: PublicSettings; save: Save; busy: boolean }) {
  const [key, setKey] = useState("");
  const [cap, setCap] = useState(String(s.exaMonthlyCap ?? 200));
  const n = Number(cap);
  const ready = s.exaKeySet && !!s.exaFreeConfirmed;
  return (
    <Item title="Exa search" state={s.exaEnabled && ready ? <Chip tone="ok">on</Chip> : <Chip>off</Chip>}>
      <p className="max-w-2xl text-muted-foreground">Optional. Off unless you add your own key, confirm the key is on Exa's free plan, and switch it on. Scholium counts every request and stops at the monthly number below, so a free allowance is not overrun.</p>
      <div className="flex max-w-xl items-end gap-2">
        <Field label={s.exaKeySet ? `Key saved (${s.exaKeyHint ?? "hidden"}). Paste a new one to replace it` : "Exa API key"}>
          <Input aria-label="Exa API key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <button type="button" className={BTN} disabled={busy || key.trim().length < 8} onClick={() => void save({ exaKey: key.trim() }, "Key saved").then((ok) => ok && setKey(""))}>
          Save
        </button>
        {s.exaKeySet && (
          <button type="button" className={BTN} disabled={busy} onClick={() => void save({ exaKey: null }, "Key removed")}>
            Remove
          </button>
        )}
      </div>
      <label className="flex items-center gap-3">
        <Switch checked={!!s.exaFreeConfirmed} disabled={busy || !s.exaKeySet} onCheckedChange={(v) => void save({ exaFreeConfirmed: v }, v ? "Confirmed" : "Confirmation removed")} />
        <span>I have checked that this key is on Exa's free plan, with no card that could be charged.</span>
      </label>
      <label className="flex items-center gap-3">
        <Switch checked={!!s.exaEnabled} disabled={busy || !ready} onCheckedChange={(v) => void save({ exaEnabled: v }, v ? "Exa is on" : "Exa is off")} />
        <span>Let runs use Exa.</span>
      </label>
      <div className="flex max-w-xs items-end gap-2">
        <Field label={`Requests per month (${s.exaUsedThisMonth ?? 0} used)`}>
          <Input aria-label="Exa requests per month" inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} />
        </Field>
        <button type="button" className={BTN} disabled={busy || !Number.isInteger(n) || n < 0 || n === (s.exaMonthlyCap ?? 200)} onClick={() => void save({ exaMonthlyCap: n }, "Number saved")}>
          Save
        </button>
      </div>
    </Item>
  );
}

function Lean({ s, save, busy }: { s: PublicSettings; save: Save; busy: boolean }) {
  const [url, setUrl] = useState(s.leanUrl);
  return (
    <Item title="Lean 4 server" state={s.leanUrl ? <Chip tone="ok">address saved</Chip> : <Chip tone="warn">not set</Chip>}>
      <p className="max-w-2xl text-muted-foreground">The address of a Lean 4 server with Mathlib that speaks the lean4web protocol. Without one, nothing can be checked formally and no claim is ever labelled formally verified.</p>
      <div className="flex max-w-xl items-end gap-2">
        <Field label="Server address">
          <Input aria-label="Lean server address" type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <button type="button" className={BTN} disabled={busy || url.trim() === s.leanUrl} onClick={() => void save({ leanUrl: url.trim() }, url.trim() ? "Address saved" : "Address removed")}>
          Save
        </button>
      </div>
    </Item>
  );
}

function Connections({ s, refresh }: { s: PublicSettings; refresh: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const wrap = async (what: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      toast.error("Not done", { description: errorText(e), duration: 12_000 });
    } finally {
      setBusy(null);
      refresh();
    }
  };
  // Google's approval happens in another tab, on the backend's own address, which cannot report back to this page.
  // So while an attempt is open this page asks the server every few seconds whether Drive is connected yet.
  const [waitUntil, setWaitUntil] = useState(0);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!waitUntil || s.drive.connected) return;
    const every = window.setInterval(() => {
      if (Date.now() > waitUntil) setWaitUntil(0);
      else refreshRef.current();
    }, 4000);
    return () => window.clearInterval(every);
  }, [waitUntil, s.drive.connected]);
  const copy = (): void => void navigator.clipboard.writeText(s.drive.redirectUri).then(() => toast.success("Copied"), () => toast.error("Could not copy. Select the address and copy it by hand."));
  return (
    <>
      <Item title="Email reports" state={s.email.configured ? <Chip tone="ok">ready</Chip> : <Chip tone="warn">needs a key</Chip>}>
        <p className="max-w-2xl text-muted-foreground">
          {s.email.configured
            ? `Reports and alerts go to ${s.email.recipient ?? "the address set on the server"}.`
            : "Sending needs a Resend key, added to this project as RESEND_API_KEY. Resend's free plan is enough. With Resend's default sender, mail is only delivered to the address the Resend account was opened with."}
        </p>
        <button
          type="button"
          className={BTN}
          disabled={busy !== null || !s.email.configured}
          onClick={() =>
            void wrap("email", async () => {
              const r = await api.testEmail();
              toast.message(`Test email to ${r.to}: ${r.status}`, { description: r.detail, duration: 12_000 });
            })
          }
        >
          {busy === "email" && <Loader2 className="h-4 w-4 animate-spin" />} Send a test
        </button>
      </Item>
      <Item title="Google Drive" state={s.drive.connected ? <Chip tone="ok">connected</Chip> : s.drive.configured ? <Chip>not connected</Chip> : <Chip tone="warn">needs credentials</Chip>}>
        <p className="max-w-2xl text-muted-foreground">
          {s.drive.connected
            ? `Connected as ${s.drive.email ?? "your Google account"}. This is a separate permission from signing in. Scholium uploads only into its own folder, and every upload is listed in the project's files.`
            : "A separate permission from signing in. Scholium asks Google only for access to files it creates itself and uploads only into its own Scholium folder."}
        </p>
        {!s.drive.configured && (
          <p className="max-w-2xl text-muted-foreground">Needs a Google OAuth client, added to this project as GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, with this address as an authorised redirect:</p>
        )}
        {!s.drive.connected && (
          <p className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded-sm bg-secondary px-2 py-1 font-mono text-[0.8rem]">{s.drive.redirectUri}</code>
            <button type="button" onClick={copy} className={BTN} aria-label="Copy the redirect address">
              <Copy className="h-3.5 w-3.5" /> Copy
            </button>
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {s.drive.connected ? (
            <button type="button" className={BTN} disabled={busy !== null} onClick={() => void wrap("drive", async () => void (await api.driveDisconnect()))}>
              {busy === "drive" && <Loader2 className="h-4 w-4 animate-spin" />} Disconnect
            </button>
          ) : (
            <button
              type="button"
              className={BTN}
              disabled={busy !== null || !s.drive.configured}
              onClick={() =>
                void wrap("drive", async () => {
                  const { url } = await api.driveStart();
                  // Google does not show its consent screen inside a frame, so it opens in its own tab.
                  setWaitUntil(Date.now() + 10 * 60_000);
                  if (!window.open(url, "_blank")) window.location.assign(url);
                })
              }
            >
              {busy === "drive" && <Loader2 className="h-4 w-4 animate-spin" />} Connect Google Drive
            </button>
          )}
          {s.drive.folderUrl && (
            <a href={s.drive.folderUrl} target="_blank" rel="noreferrer" className={BTN}>
              <ExternalLink className="h-3.5 w-3.5" /> Open the Scholium folder
            </a>
          )}
        </div>
      </Item>
    </>
  );
}

const show = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

function Checks({ d, refresh }: { d: WorkspaceOverview; refresh: () => void }) {
  const [fresh, setFresh] = useState<{ results: DiagnosticResult[]; at: number } | null>(null);
  const [models, setModels] = useState<ModelKey[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const results = fresh?.results ?? d.diagnostics;
  const at = fresh?.at ?? d.diagnosticsAt;

  const run = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    try {
      setFresh(await api.diagnostics(models.length ? { models } : {}));
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
      refresh();
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="max-w-2xl text-muted-foreground">Each check makes one real request to the service and reports what came back. Nothing here is simulated: a tool that fails its check is reported to the models as unavailable.</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" className={BTN} disabled={running} onClick={() => void run()}>
          {running && <Loader2 className="h-4 w-4 animate-spin" />} Run the checks
        </button>
        {at ? <span className="text-muted-foreground">Last run {timeAgo(at)}</span> : <span className="text-muted-foreground">Not run yet</span>}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-muted-foreground">Also call these models once. Each is a real call at full reasoning effort and counts against the ceiling.</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {MODEL_KEYS.map((k) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--rubric))]" checked={models.includes(k)} disabled={running} onChange={(e) => setModels((m) => (e.target.checked ? [...m, k] : m.filter((x) => x !== k)))} />
              <ModelTag model={k} full />
              <span className="font-mono text-[0.72rem] text-muted-foreground">{MODELS[k].id}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {error !== null && <ErrorNote error={error} />}
      {results.length > 0 && (
        <ul className="hairline divide-y border-y">
          {results.map((r) => (
            <li key={r.check} className="grid grid-cols-[1.25rem_minmax(0,9rem)_1fr] items-start gap-x-3 py-2">
              {r.ok ? <Check className="mt-0.5 h-4 w-4 text-ok" aria-label="works" /> : <X className="mt-0.5 h-4 w-4 text-destructive" aria-label="failed" />}
              <span className="break-words font-mono text-[0.8rem]">{r.check}</span>
              <span className="min-w-0 break-words">
                {r.detail} <span className="tabular text-muted-foreground">{r.ms} ms</span>
                {(r.requested !== undefined || r.reported !== undefined) && (
                  <span className="block font-mono text-[0.74rem] text-muted-foreground">
                    {r.requested !== undefined && <>asked for {show(r.requested)} </>}
                    {r.reported !== undefined && <>· provider reported {show(r.reported)}</>}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Settings() {
  const ws = useWorkspace();
  const queryClient = useQueryClient();
  const { access, signOut } = useAuth();
  const [busy, setBusy] = useState(false);

  const refresh = (): void => void queryClient.invalidateQueries({ queryKey: ["workspace"] });
  const save: Save = async (patch, done) => {
    setBusy(true);
    try {
      await api.saveSettings(patch);
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
      toast.success(done);
      return true;
    } catch (e) {
      toast.error("Not saved", { description: errorText(e), duration: 12_000 });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const d = ws.data;
  return (
    <Page eyebrow="Workspace" title="Settings">
      {!d ? (
        ws.isError ? (
          <ErrorNote error={ws.error} retry={() => void ws.refetch()} />
        ) : (
          <Loading what="Loading the settings" />
        )
      ) : (
        <div className="space-y-14">
          <Section title="Spending">
            <Spending key={d.budget.capUsd} d={d} save={save} busy={busy} />
          </Section>
          <Section title="Free allowance of the server">
            <Allowance u={d.usage} />
          </Section>
          <Section title="Connections">
            <Connections s={d.settings} refresh={refresh} />
            <Exa key={`${d.settings.exaMonthlyCap}`} s={d.settings} save={save} busy={busy} />
            <Lean key={d.settings.leanUrl} s={d.settings} save={save} busy={busy} />
          </Section>
          <Section title="Connection checks">
            <Checks d={d} refresh={refresh} />
          </Section>
          <Section title="Method notes">
            <Methods />
          </Section>
          <Section title="This session">
            <div className="space-y-4 text-sm">
              <p className="max-w-2xl text-muted-foreground">
                Signed in as <span className="text-foreground">{access.state === "allowed" ? access.email : "…"}</span>. Only this Google account can open the workspace, and the server checks it again on every request. Projects that are running keep running while you are signed out.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <ThemeToggle />
                <button type="button" className={BTN} onClick={signOut}>
                  <LogOut className="h-3.5 w-3.5" /> Sign out
                </button>
              </div>
              <p className="text-xs text-muted-foreground">Scholium {d.version}</p>
            </div>
          </Section>
        </div>
      )}
    </Page>
  );
}
