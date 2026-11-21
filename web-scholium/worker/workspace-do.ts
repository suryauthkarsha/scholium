// The workspace: the project list, settings, the monthly spending ceiling, free-allowance counters,
// integration checks and the Google Drive connection. One per owner; reachable only from the router and runs.
import { DurableObject } from "cloudflare:workers";
import { createGateway } from "../src/engine/providers";
import { createServices, type Services } from "../src/engine/services";
import { b64decode, b64encode, clip, errText, fmtUsd, oneLine } from "../src/engine/util";
import * as B from "../src/shared/budget";
import { ALLOWED_EMAIL, emailAllowed, ownerHashFor } from "../src/shared/gate";
import { issue, readLinks, redeem, settle, type DriveLinks } from "../src/shared/driveLink";
import { costOf, MODEL_KEYS, MODELS, type ModelKey, worstCaseCost } from "../src/shared/models";
import type { DiagnosticResult, PublicSettings, RunSummary, WorkspaceOverview } from "../src/shared/types";
import { type Env, fail, fromInside, json, notFound, readBody, rec } from "./env";
import { StrategyBook } from "../src/engine/strategy";

export const VERSION = "2026.11.2";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FLUSH_MS = 15_000;
export const TOOL_CHECKS = ["web", "search:ddg", "search:wikipedia", "search:stackexchange", "literature", "search:zbmath", "oeis", "lmfdb", "reader:jina", "sage", "lean", "email", "drive"];

interface Settings {
  leanUrl: string;
  exaKey?: string;
  exaHint?: string;
  exaFreeConfirmed: boolean;
  exaEnabled: boolean;
  exaMonthlyCap: number;
}
interface DriveState {
  refresh?: string;
  email?: string;
  rootId?: string;
  /** The older single-attempt record; read once and then dropped. */
  pending?: { nonce: string; redirectUri: string; at: number };
  links?: DriveLinks;
}
interface State {
  settings: Settings;
  exaUse: { month: string; n: number };
  budget: B.BudgetState;
  usage: B.DailyUsage;
  takes: B.TakeCounters;
  diag: { at?: number; results: DiagnosticResult[] };
  drive: DriveState;
}

async function vaultKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`scholium-vault:${secret}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
/** Encrypts a credential before it is stored. */
export async function lock(secret: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await vaultKey(secret), new TextEncoder().encode(text)));
  return `${b64encode(iv)}.${b64encode(ct)}`;
}
export async function unlock(secret: string, sealed: string): Promise<string | null> {
  try {
    const [iv, ct] = sealed.split(".");
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(iv) }, await vaultKey(secret), b64decode(ct)));
  } catch {
    return null;
  }
}

export class Workspace extends DurableObject<Env> {
  private s: State;
  private runs = new Map<string, RunSummary>();
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private own = { read: 0, written: 0, calls: 0 };
  private mem: { token: string; exp: number } | null = null;
  private book: StrategyBook;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.q("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID");
    const now = Date.now();
    const saved: Record<string, unknown> = {};
    for (const r of this.q("SELECT k, v FROM kv")) {
      try {
        const k = String(r.k);
        const v = JSON.parse(String(r.v)) as unknown;
        if (k.startsWith("run:")) this.runs.set(k.slice(4), v as RunSummary);
        else saved[k] = v;
      } catch {
        // An unreadable row is ignored; defaults apply.
      }
    }
    this.s = {
      settings: { leanUrl: "", exaFreeConfirmed: false, exaEnabled: false, exaMonthlyCap: 200, ...(saved.settings as Partial<Settings> | undefined) },
      exaUse: (saved.exaUse as State["exaUse"] | undefined) ?? { month: B.monthOf(now), n: 0 },
      budget: (saved.budget as B.BudgetState | undefined) ?? B.newBudget(now),
      usage: (saved.usage as B.DailyUsage | undefined) ?? B.newUsage(now),
      takes: (saved.takes as B.TakeCounters | undefined) ?? { day: B.dayOf(now), email: 0, drive: 0 },
      diag: (saved.diag as State["diag"] | undefined) ?? { results: [] },
      drive: (saved.drive as DriveState | undefined) ?? {},
    };
    this.book = new StrategyBook(saved.strategy, (v) => this.put("strategy", v));
  }

  // ---------- Storage ----------
  private q(query: string, ...bindings: unknown[]): Record<string, unknown>[] {
    const c = this.ctx.storage.sql.exec(query, ...bindings);
    const rows = c.toArray() as Record<string, unknown>[];
    this.own.read += c.rowsRead;
    this.own.written += c.rowsWritten;
    return rows;
  }

  private put(k: string, v: unknown): void {
    this.q("INSERT OR REPLACE INTO kv VALUES (?, ?)", k, JSON.stringify(v));
  }

  /** Counters are written at most every few seconds; settings and credentials at once. */
  private save(key: keyof State | `run:${string}`, now = false): void {
    this.dirty.add(key);
    if (now) return this.flush();
    if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    B.addUsage(this.s.usage, this.own, Date.now());
    this.own = { read: 0, written: 0, calls: 0 };
    this.dirty.add("usage");
    for (const k of this.dirty) {
      if (k.startsWith("run:")) {
        const r = this.runs.get(k.slice(4));
        if (r) this.put(k, r);
        else this.q("DELETE FROM kv WHERE k = ?", k);
      } else this.put(k, this.s[k as keyof State]);
    }
    this.dirty.clear();
  }

  // ---------- Hard limits on free-tier side effects ----------
  private takeOne(kind: "exa" | "email" | "drive"): boolean {
    const now = Date.now();
    if (kind !== "exa") {
      const ok = B.take(this.s.takes, kind, now);
      this.save("takes");
      return ok;
    }
    const s = this.s.settings;
    if (this.s.exaUse.month !== B.monthOf(now)) this.s.exaUse = { month: B.monthOf(now), n: 0 };
    if (!s.exaKey || !s.exaEnabled || !s.exaFreeConfirmed || this.s.exaUse.n >= s.exaMonthlyCap) return false;
    this.s.exaUse.n++;
    this.save("exaUse");
    return true;
  }

  private async secrets(): Promise<{ exaKey?: string; leanUrl?: string }> {
    const s = this.s.settings;
    const usable = !!s.exaKey && s.exaEnabled && s.exaFreeConfirmed;
    return { exaKey: usable && s.exaKey ? ((await unlock(this.env.SCHOLIUM_SECRET, s.exaKey)) ?? undefined) : undefined, leanUrl: s.leanUrl || undefined };
  }

  private services(): Services {
    const env = this.env;
    return createServices({
      llm: createGateway({ secret: env.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY }),
      toolkitSecret: env.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY,
      settings: () => this.secrets(),
      driveToken: () => this.driveToken(),
      driveRoot: {
        get: async () => this.s.drive.rootId,
        set: async (id) => {
          this.s.drive.rootId = id;
          this.save("drive", true);
        },
      },
      resendKey: env.RESEND_API_KEY,
      emailTo: env.ALERT_EMAIL_TO,
      emailFrom: env.RESEND_FROM,
      take: async (k) => this.takeOne(k),
    });
  }

  private publicSettings(origin: string): PublicSettings {
    const s = this.s.settings;
    const d = this.s.drive;
    const env = this.env;
    return {
      exaKeySet: !!s.exaKey,
      exaKeyHint: s.exaHint,
      exaFreeConfirmed: s.exaFreeConfirmed,
      exaEnabled: s.exaEnabled,
      exaMonthlyCap: s.exaMonthlyCap,
      exaUsedThisMonth: this.s.exaUse.month === B.monthOf(Date.now()) ? this.s.exaUse.n : 0,
      monthlyCapUsd: this.s.budget.capUsd,
      leanUrl: s.leanUrl,
      email: { configured: !!env.RESEND_API_KEY && !!env.ALERT_EMAIL_TO, recipient: env.ALERT_EMAIL_TO },
      drive: { configured: !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET, connected: !!d.refresh, email: d.email, redirectUri: `${origin}/api/drive/callback`, folderUrl: d.rootId ? `https://drive.google.com/drive/folders/${d.rootId}` : undefined },
    };
  }

  // ---------- Requests ----------
  async fetch(request: Request): Promise<Response> {
    this.own.calls++;
    if (!(await fromInside(request, this.env))) return notFound();
    // There is exactly one workspace, and it belongs to exactly one account.
    if (request.headers.get("x-scholium-owner") !== (await ownerHashFor(ALLOWED_EMAIL))) return notFound();
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      return await this.route(request, url, method, path);
    } catch (err) {
      console.error("workspace request failed:", method, path, errText(err).slice(0, 300));
      return fail(500, "server_error", "The workspace could not complete this request.");
    }
  }

  private async route(request: Request, url: URL, method: string, path: string): Promise<Response> {
    const now = Date.now();
    if (method === "GET") {
      if (path === "/internal/overview") {
        const out: WorkspaceOverview = {
          runs: [...this.runs.values()].sort((a, b) => b.updatedAt - a.updatedAt),
          settings: this.publicSettings((url.searchParams.get("origin") ?? "").slice(0, 200)),
          budget: B.view(this.s.budget, now),
          usage: B.usageView(this.s.usage, this.s.takes, now),
          diagnostics: this.s.diag.results,
          diagnosticsAt: this.s.diag.at,
          version: VERSION,
        };
        return json(out);
      }
      if (path === "/internal/secrets") return json(await this.secrets());
      if (path === "/internal/drive-root") return json({ id: this.s.drive.rootId });
      if (path === "/internal/strategy") return json(this.book.view());
      if (path === "/internal/strategy/active") return json(this.book.active());
      return notFound();
    }
    if (method === "DELETE") {
      const m = /^\/internal\/runs\/([a-z0-9]{16,40})$/.exec(path);
      if (!m) return notFound();
      this.runs.delete(m[1]);
      B.remove(this.s.budget, m[1]);
      this.save(`run:${m[1]}`);
      this.save("budget", true);
      return json({ ok: true });
    }
    const b = await readBody(request);

    if (path === "/internal/grant") {
      const blocked = B.allowanceBlocked(this.s.usage, now);
      if (blocked) return json({ ok: false, reason: blocked });
      const g = B.grant(this.s.budget, String(b.runId ?? ""), { limitUsd: Number(b.limitUsd) || 0, spentUsd: Number(b.spentUsd) || 0, reservedUsd: Number(b.reservedUsd) || 0 }, now);
      this.save("budget", true);
      return json(g);
    }
    if (path === "/internal/report") {
      const sum = rec(b.summary) as unknown as RunSummary;
      const l = rec(b.ledger);
      const u = rec(b.usage);
      if (typeof sum.id !== "string") return fail(400, "bad_request", "No run was named.");
      this.runs.set(sum.id, sum);
      this.save(`run:${sum.id}`);
      B.addUsage(this.s.usage, { written: Number(u.written) || 0, read: Number(u.read) || 0, calls: Number(u.calls) || 0 }, now);
      const r = B.report(this.s.budget, sum.id, { limitUsd: Number(l.limitUsd) || 0, spentUsd: Number(l.spentUsd) || 0, reservedUsd: Number(l.reservedUsd) || 0, active: l.active === true }, now);
      this.save("budget");
      const blocked = l.active === true ? B.allowanceBlocked(this.s.usage, now) : null;
      return json({ ...r, pause: blocked ?? undefined });
    }
    if (path === "/internal/take") {
      const k = String(b.kind ?? "");
      return json({ ok: (k === "exa" || k === "email" || k === "drive") && this.takeOne(k) });
    }
    if (path === "/internal/drive-token") return json(await this.driveToken());
    if (path === "/internal/drive-root" && method === "PUT") {
      if (typeof b.id === "string" && /^[A-Za-z0-9_-]{5,200}$/.test(b.id)) {
        this.s.drive.rootId = b.id;
        this.save("drive", true);
      }
      return json({ ok: true });
    }
    if (path === "/internal/settings" && method === "PUT") return this.setSettings(b, now);
    if (path === "/internal/diagnostics") return this.diagnostics(b);
    if (path === "/internal/test-email") {
      const to = this.env.ALERT_EMAIL_TO ?? "";
      if (!this.takeOne("email")) return json({ status: "skipped", detail: "Today's email limit was reached, so nothing was sent.", to });
      return json(await this.services().email({ subject: "Scholium: test message", text: "This is a test message from your Scholium workspace. Alerts will arrive at this address.", html: "<p>This is a test message from your Scholium workspace. Alerts will arrive at this address.</p>" }));
    }
    if (path === "/internal/drive/start") return this.driveStart(b);
    if (path === "/internal/drive/callback") return this.driveCallback(b);
    if (path === "/internal/drive/disconnect") return this.driveDisconnect();
    const sm = /^\/internal\/strategy\/(propose|evaluate|adopt|reject|rollback)$/.exec(path);
    if (sm) {
      const r = await this.book.act(sm[1], b, {
        now,
        llm: this.services().llm,
        canSpend: (usd) => B.canSpend(this.s.budget, usd, Date.now()),
        charge: (usd) => {
          B.chargeDiag(this.s.budget, usd, Date.now());
          this.save("budget", true);
        },
      });
      return r.ok ? json({ ok: true, ...this.book.view() }) : fail(409, "refused", r.error);
    }
    return notFound();
  }

  private async setSettings(b: Record<string, unknown>, now: number): Promise<Response> {
    const s = this.s.settings;
    if (b.monthlyCapUsd !== undefined) {
      const cap = Number(b.monthlyCapUsd);
      if (!Number.isFinite(cap) || cap < 0 || cap > B.MAX_MONTHLY_CAP_USD) return fail(400, "bad_request", `The monthly ceiling must be between $0 and $${B.MAX_MONTHLY_CAP_USD}.`);
      B.setCap(this.s.budget, cap, now);
      this.save("budget");
    }
    if (typeof b.leanUrl === "string") {
      const u = b.leanUrl.trim().slice(0, 300);
      if (u && !/^(wss|https):\/\/[^\s]+$/.test(u)) return fail(400, "bad_request", "The Lean server address must start with wss:// or https://.");
      s.leanUrl = u;
    }
    if (b.exaKey === null || b.exaKey === "") {
      s.exaKey = s.exaHint = undefined;
      s.exaEnabled = s.exaFreeConfirmed = false;
    } else if (typeof b.exaKey === "string") {
      const k = b.exaKey.trim();
      if (k.length < 8 || k.length > 200 || /\s/.test(k)) return fail(400, "bad_request", "That does not look like an Exa key.");
      s.exaKey = await lock(this.env.SCHOLIUM_SECRET, k);
      s.exaHint = `…${k.slice(-4)}`;
      s.exaEnabled = s.exaFreeConfirmed = false;
    }
    if (typeof b.exaFreeConfirmed === "boolean") s.exaFreeConfirmed = b.exaFreeConfirmed;
    if (typeof b.exaEnabled === "boolean") s.exaEnabled = b.exaEnabled;
    if (b.exaMonthlyCap !== undefined) s.exaMonthlyCap = Math.max(0, Math.min(100_000, Math.floor(Number(b.exaMonthlyCap) || 0)));
    // Exa is used only with a key, an explicit confirmation that the plan cannot bill, and a hard monthly request cap.
    if (!s.exaKey || !s.exaFreeConfirmed) s.exaEnabled = false;
    this.save("settings", true);
    return json({ ok: true });
  }

  // ---------- Integration checks ----------
  private async diagnostics(b: Record<string, unknown>): Promise<Response> {
    const svc = this.services();
    const want = Array.isArray(b.checks) ? b.checks.map(String) : TOOL_CHECKS;
    const results: DiagnosticResult[] = await Promise.all(
      TOOL_CHECKS.filter((t) => want.includes(t)).map(async (tool) => {
        const t0 = Date.now();
        try {
          const r = await svc.preflight(tool);
          return { check: tool, ok: r.ok, ms: Date.now() - t0, detail: clip(r.detail, 400) };
        } catch (e) {
          return { check: tool, ok: false, ms: Date.now() - t0, detail: clip(errText(e), 400) };
        }
      }),
    );
    // Model checks are real calls and cost real credit, so they run only when asked for, and only under the ceiling.
    const models = (Array.isArray(b.models) ? b.models.map(String) : []).filter((k): k is ModelKey => (MODEL_KEYS as string[]).includes(k));
    for (const key of models) results.push(await this.modelCheck(svc, key));
    const merged = new Map(this.s.diag.results.map((r) => [r.check, r]));
    for (const r of results) merged.set(r.check, r);
    this.s.diag = { at: Date.now(), results: [...merged.values()] };
    this.save("diag", true);
    this.save("budget", true);
    return json({ results: this.s.diag.results, at: this.s.diag.at });
  }

  private async modelCheck(svc: Services, key: ModelKey): Promise<DiagnosticResult> {
    const check = `model:${key}`;
    if (!B.canSpend(this.s.budget, worstCaseCost(key, 300, 2000), Date.now())) return { check, ok: false, ms: 0, detail: "Skipped: the monthly ceiling leaves no room for this check." };
    const t0 = Date.now();
    try {
      const r = await svc.llm.call({ model: key, system: "You are a connectivity check.", messages: [{ role: "user", text: "Reply with the single word: ready", origin: "system" }], tools: [], maxOutput: 2000, purpose: "diagnostic", signal: AbortSignal.timeout(150_000) });
      const cost = costOf(key, r.usage);
      B.chargeDiag(this.s.budget, cost, Date.now());
      return { check, ok: true, ms: r.ms, detail: `Answered "${clip(oneLine(r.text), 60)}" for ${fmtUsd(cost)}.`, requested: { model: MODELS[key].id, effort: r.requested.effort }, reported: r.reported };
    } catch (e) {
      return { check, ok: false, ms: Date.now() - t0, detail: clip(errText(e), 400), requested: { model: MODELS[key].id, effort: MODELS[key].effort } };
    }
  }

  // ---------- Google Drive (separate authorisation, upload-only, one folder) ----------
  private google(): { id: string; secret: string } | null {
    const id = this.env.GOOGLE_CLIENT_ID;
    const secret = this.env.GOOGLE_CLIENT_SECRET;
    return id && secret ? { id, secret } : null;
  }

  private tokenCall(params: Record<string, string>): Promise<Response> {
    return fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
  }

  private async driveToken(): Promise<{ token?: string; error?: string }> {
    const g = this.google();
    const d = this.s.drive;
    if (!g) return { error: "Google Drive is not configured." };
    if (!d.refresh) return { error: "Google Drive is not connected." };
    if (this.mem && this.mem.exp > Date.now() + 60_000) return { token: this.mem.token };
    const refresh = await unlock(this.env.SCHOLIUM_SECRET, d.refresh);
    if (!refresh) return { error: "The stored Google Drive authorisation could not be read. Connect again in Settings." };
    const r = await this.tokenCall({ grant_type: "refresh_token", refresh_token: refresh, client_id: g.id, client_secret: g.secret });
    const j = rec(await r.json().catch(() => ({})));
    if (!r.ok || typeof j.access_token !== "string") {
      if (j.error === "invalid_grant") {
        this.s.drive = { rootId: d.rootId };
        this.mem = null;
        this.save("drive", true);
        return { error: "Google Drive access was withdrawn or has expired. Connect again in Settings." };
      }
      return { error: `Google did not issue a token (${String(j.error ?? r.status).slice(0, 80)}).` };
    }
    this.mem = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000 };
    return { token: this.mem.token };
  }

  /** Marks the attempt lists that were validated after being read from storage. */
  private linksChecked = new WeakSet<DriveLinks>();

  /** The open connection attempts, carrying over the older stored shape the first time it is read. */
  private driveLinks(): DriveLinks {
    const d = this.s.drive;
    if (!d.links || !this.linksChecked.has(d.links)) d.links = readLinks(d.links, d.pending);
    this.linksChecked.add(d.links);
    d.pending = undefined;
    return d.links;
  }

  private driveStart(b: Record<string, unknown>): Response {
    const g = this.google();
    if (!g) return fail(409, "not_configured", "Google Drive needs a Google client ID and secret before it can be connected.");
    const nonce = String(b.nonce ?? "");
    const redirectUri = String(b.redirectUri ?? "");
    if (!nonce || !/^https:\/\/[^\s]+\/api\/drive\/callback$/.test(redirectUri)) return fail(400, "bad_request", "The connection could not be started.");
    const links = this.driveLinks();
    issue(links, nonce, redirectUri, Date.now());
    this.save("drive", true);
    const p = new URLSearchParams({ client_id: g.id, redirect_uri: redirectUri, response_type: "code", scope: `${DRIVE_SCOPE} openid email`, access_type: "offline", prompt: "consent select_account", include_granted_scopes: "false", login_hint: ALLOWED_EMAIL, state: String(b.state ?? "") });
    return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}` });
  }

  private async driveCallback(b: Record<string, unknown>): Promise<Response> {
    const g = this.google();
    const nonce = String(b.nonce ?? "");
    // The attempt is used up before anything else happens, so the same redirect can never be exchanged twice.
    const p = redeem(this.driveLinks(), nonce, Date.now());
    this.save("drive", true);
    if (p.kind === "repeat") {
      // The same redirect loaded again. Say what the first load did; exchange nothing.
      const stillTrue = !p.ok || !!this.s.drive.refresh;
      console.log("drive callback: repeat of a settled attempt", p.ok ? "ok" : "failed");
      return stillTrue ? json({ ok: p.ok, message: p.message }, p.ok ? 200 : 400) : json({ ok: false, message: "Google Drive is no longer connected. Start again from Settings in Scholium." }, 400);
    }
    if (p.kind !== "fresh" || !g) {
      console.log("drive callback refused:", !g ? "not_configured" : p.kind);
      const why = !g
        ? "Google Drive is not configured on this server."
        : p.kind === "expired"
          ? "More than ten minutes passed between pressing Connect and approving, so this attempt lapsed."
          : "This connection attempt is not open on this workspace: it was already used, or it was not started here.";
      return json({ ok: false, message: `${why} Nothing was changed. Start again from Settings in Scholium.` }, 400);
    }
    const bad = (message: string): Response => {
      settle(this.driveLinks(), nonce, false, message, Date.now());
      this.save("drive", true);
      console.log("drive callback failed:", message.slice(0, 160));
      return json({ ok: false, message }, 400);
    };
    if (b.error) return bad(`Google reported "${String(b.error).slice(0, 80)}". Nothing was connected.`);
    if (typeof b.code !== "string" || !b.code) return bad("Google did not return an authorisation code. Nothing was connected.");
    const r = await this.tokenCall({ grant_type: "authorization_code", code: b.code, client_id: g.id, client_secret: g.secret, redirect_uri: p.redirectUri });
    const j = rec(await r.json().catch(() => ({})));
    const access = j.access_token;
    if (!r.ok || typeof access !== "string") return bad(`Google refused the authorisation (${String(j.error ?? r.status).slice(0, 80)}). Nothing was connected.`);
    const revoke = (t: string): Promise<unknown> => fetch(`${REVOKE_URL}?token=${encodeURIComponent(t)}`, { method: "POST" }).catch(() => undefined);
    const info = rec(await (await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${access}` } })).json().catch(() => ({})));
    if (typeof info.email !== "string" || info.email_verified !== true || !emailAllowed(info.email)) {
      await revoke(access);
      return bad("That Google account is not the one this workspace belongs to. Nothing was connected.");
    }
    if (!String(j.scope ?? "").split(" ").includes(DRIVE_SCOPE)) {
      await revoke(access);
      return bad("Permission to save files was not granted, so nothing was connected.");
    }
    if (typeof j.refresh_token !== "string") {
      await revoke(access);
      return bad("Google did not grant ongoing access. Try connecting again.");
    }
    const done = "Scholium can now save reports into a Scholium folder in your Google Drive. It can only see files it created itself. You can close this tab.";
    this.s.drive = { refresh: await lock(this.env.SCHOLIUM_SECRET, j.refresh_token), email: info.email, rootId: this.s.drive.rootId, links: this.driveLinks() };
    settle(this.driveLinks(), nonce, true, done, Date.now());
    this.mem = { token: access, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000 };
    this.save("drive", true);
    return json({ ok: true, message: done });
  }

  private async driveDisconnect(): Promise<Response> {
    const d = this.s.drive;
    const refresh = d.refresh ? await unlock(this.env.SCHOLIUM_SECRET, d.refresh) : null;
    if (refresh) await fetch(`${REVOKE_URL}?token=${encodeURIComponent(refresh)}`, { method: "POST" }).catch(() => undefined);
    this.s.drive = { rootId: d.rootId };
    this.mem = null;
    this.save("drive", true);
    return json({ ok: true });
  }
}
