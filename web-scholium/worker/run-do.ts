// One research run: its database, its engine, its live viewers. The run keeps working here whether or not
// anyone is signed in or watching. Only the router and sibling objects can reach it (see fromInside).
import { DurableObject } from "cloudflare:workers";
import type { CheckpointExport } from "../src/engine/background";
import { Engine, type ActionResult } from "../src/engine/engine";
import { createGateway } from "../src/engine/providers";
import { createServices, type Services } from "../src/engine/services";
import type { ActiveMethod } from "../src/engine/strategy";
import { errText, fmtUsd } from "../src/engine/util";
import { WS_TICKET_TTL_MS } from "../src/shared/gate";
import { ENTITY_KINDS, type EntityKind, type RunSummary, type ServerMsg } from "../src/shared/types";
import { callObject, type Env, fail, fromInside, json, notFound, readBody, rec } from "./env";
import { SqlStore } from "./sql-store";

const BIG = 350_000;
const BATCH = 300_000;
const WATCHDOG_MS = 45_000;
const REPORT_MS = 10_000;
const ID = "([A-Za-z0-9_-]{1,64})";

const attachment = (name: string): string => `attachment; filename="${name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "file"}"`;

export class ResearchRun extends DurableObject<Env> {
  private store: SqlStore;
  private engine: Engine | null = null;
  private owner = "";
  private runId = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = 0;
  private alarmAt = 0;
  private ticking = false;
  private again = false;
  private reportTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSig = "";
  private reported = { written: 0, read: 0, calls: 0 };
  private calls = 0;
  private destroyed = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqlStore(ctx.storage);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---------- Engine ----------
  private workspace(method: string, path: string, body?: unknown): Promise<Response> {
    return callObject(this.env.WORKSPACE, `ws:${this.owner}`, this.env, this.owner, method, path, body);
  }

  private async ask<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    try {
      const r = await this.workspace(method, path, body);
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  }

  private build(): Engine {
    const env = this.env;
    // Every free-tier side effect asks the workspace first, which counts it against a hard daily or monthly cap.
    const take = async (kind: "exa" | "email" | "drive"): Promise<boolean> => (await this.ask<{ ok?: boolean }>("POST", "/internal/take", { kind }))?.ok === true;
    const base = createServices({
      llm: createGateway({ secret: env.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY }),
      toolkitSecret: env.EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY,
      settings: async () => (await this.ask<{ exaKey?: string; leanUrl?: string }>("GET", "/internal/secrets")) ?? {},
      driveToken: async () => (await this.ask<{ token?: string; error?: string }>("POST", "/internal/drive-token")) ?? { error: "The workspace could not be reached." },
      driveRoot: {
        get: async () => (await this.ask<{ id?: string }>("GET", "/internal/drive-root"))?.id,
        set: async (id) => {
          await this.ask("PUT", "/internal/drive-root", { id });
        },
      },
      resendKey: env.RESEND_API_KEY,
      stackExchangeKey: env.STACKEXCHANGE_KEY,
      emailTo: env.ALERT_EMAIL_TO,
      emailFrom: env.RESEND_FROM,
      take,
    });
    const services: Services = {
      ...base,
      method: () => this.ask<ActiveMethod>("GET", "/internal/strategy/active"),
      email: async (msg) => ((await take("email")) ? base.email(msg) : { status: "skipped", detail: "Today's email limit was reached, so nothing was sent.", to: env.ALERT_EMAIL_TO ?? "" }),
      drive: {
        ...base.drive,
        putFile: async (folderId, name, mime, content, existing) => {
          if (!(await take("drive"))) throw new Error("Today's Google Drive upload limit was reached.");
          return base.drive.putFile(folderId, name, mime, content, existing);
        },
      },
    };
    return new Engine(this.store, services, { broadcast: (m) => this.broadcast(m), wake: (d) => this.wake(d), summary: (s) => this.queueReport(s) });
  }

  private ensure(): Engine | null {
    if (this.engine) return this.engine;
    if (this.destroyed) return null;
    const meta = this.store.kvGet<{ id: string; owner: string }>("meta");
    if (!meta) return null;
    this.runId = meta.id;
    this.owner = meta.owner;
    const e = this.build();
    if (!e.load()) return null;
    this.engine = e;
    // A run that was working when this object was last unloaded picks up where it stopped.
    if (e.run.status === "running") void this.wake(0);
    return e;
  }

  private async wake(delayMs: number): Promise<void> {
    if (this.destroyed) return;
    const now = Date.now();
    const at = now + Math.max(0, Math.min(delayMs, 3_600_000));
    if (!this.timer || at < this.timerAt - 5) {
      if (this.timer) clearTimeout(this.timer);
      this.timerAt = at;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.tick();
      }, at - now);
    }
    // The alarm is the safety net: it brings the object back if it is unloaded while it waits.
    if (this.alarmAt < at || this.alarmAt > at + 2 * WATCHDOG_MS) {
      this.alarmAt = at + WATCHDOG_MS;
      try {
        await this.ctx.storage.setAlarm(this.alarmAt);
      } catch {
        this.alarmAt = 0;
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.destroyed) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.again = false;
        const e = this.ensure();
        if (!e) break;
        await e.tick();
      } while (this.again && !this.destroyed);
    } catch (err) {
      console.error("tick failed:", errText(err).slice(0, 300));
    } finally {
      this.ticking = false;
    }
  }

  async alarm(): Promise<void> {
    this.alarmAt = 0;
    await this.tick();
  }

  // ---------- Budget and the project list ----------
  /** Asks the workspace to set aside this run's spending limit under the monthly ceiling. Returns why not, or null. */
  private async grant(e: Engine): Promise<string | null> {
    const run = e.run;
    let out: Record<string, unknown> = {};
    try {
      const res = await this.workspace("POST", "/internal/grant", { runId: this.runId, limitUsd: run.config.limits.spendUsd, spentUsd: run.spend.usd, reservedUsd: run.spend.reservedUsd });
      out = rec(await res.json().catch(() => ({})));
    } catch {
      out = {};
    }
    if (out.ok !== true) return typeof out.reason === "string" ? out.reason : "The workspace could not confirm the budget for this run, so it was not started.";
    if (out.clamped === true && typeof out.limitUsd === "number") {
      e.updateConfig({ limits: { spendUsd: out.limitUsd } });
      e.event("warn", "budget", `This run's spending limit was set to ${fmtUsd(out.limitUsd)}, which is what is left under the monthly ceiling.`);
    }
    return null;
  }

  private queueReport(_s?: RunSummary): void {
    if (this.reportTimer || this.destroyed) return;
    this.reportTimer = setTimeout(() => {
      this.reportTimer = null;
      void this.report();
    }, REPORT_MS);
  }

  private async report(): Promise<void> {
    const e = this.engine;
    if (!e || this.destroyed) return;
    const run = e.run;
    const now = { written: this.store.written, read: this.store.read, calls: this.calls };
    const usage = { written: now.written - this.reported.written, read: now.read - this.reported.read, calls: now.calls - this.reported.calls };
    const body = { summary: e.summary(), ledger: { limitUsd: run.config.limits.spendUsd, spentUsd: run.spend.usd, reservedUsd: run.spend.reservedUsd, active: run.status === "running" }, usage };
    const sig = JSON.stringify([body.summary, body.ledger]);
    if (sig === this.lastSig && usage.written + usage.calls < 200 && usage.read < 20_000) return;
    try {
      const res = await this.workspace("POST", "/internal/report", body);
      if (!res.ok) return;
      this.lastSig = sig;
      this.reported = now;
      const out = rec(await res.json().catch(() => ({})));
      if (typeof out.clampTo === "number") {
        const to = Math.max(1, out.clampTo);
        e.updateConfig({ limits: { spendUsd: to } });
        e.event("warn", "budget", `This run's spending limit was lowered to ${fmtUsd(to)} to stay inside the monthly ceiling.`);
        if (out.clampTo < 1 && run.status === "running") e.pauseRun("The monthly spending ceiling has been reached. Raise it in Settings to continue.", true);
      }
      if (out.ungranted === true && run.status === "running") {
        const denied = await this.grant(e);
        if (denied) e.pauseRun(denied, true);
      }
      if (typeof out.pause === "string" && out.pause && run.status === "running") e.pauseRun(out.pause, true);
    } catch {
      // The next report retries.
    }
  }

  // ---------- Live viewers ----------
  private broadcast(msg: ServerMsg): void {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    let text = JSON.stringify(msg);
    if (text.length > BIG) {
      if (msg.t !== "put") return;
      text = JSON.stringify({ t: "big", kind: msg.kind, id: msg.id } satisfies ServerMsg);
    }
    for (const ws of sockets) {
      try {
        ws.send(text);
      } catch {
        // The viewer has gone.
      }
    }
  }

  /** Sends the whole current state to one viewer, in pieces small enough for a live message. */
  private sync(ws: WebSocket, e: Engine): void {
    const raw = (text: string): void => {
      try {
        ws.send(text);
      } catch {
        // The viewer has gone.
      }
    };
    raw(JSON.stringify({ t: "snapshot", entities: {}, events: this.store.loadEvents(300) } satisfies ServerMsg));
    const snap = e.publicSnapshot();
    let parts: string[] = [];
    let size = 0;
    const flush = (): void => {
      if (parts.length) raw(`{"t":"batch","items":[${parts.join(",")}]}`);
      parts = [];
      size = 0;
    };
    for (const kind of ENTITY_KINDS) {
      for (const data of (snap[kind] ?? []) as { id: string }[]) {
        const item = JSON.stringify({ kind, id: data.id, data });
        if (item.length > BIG) {
          raw(JSON.stringify({ t: "big", kind, id: data.id } satisfies ServerMsg));
          continue;
        }
        if (size + item.length > BATCH) flush();
        parts.push(item);
        size += item.length + 1;
      }
    }
    flush();
    raw('{"t":"ready"}');
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 2000) return;
    let m: Record<string, unknown>;
    try {
      m = rec(JSON.parse(message));
    } catch {
      return;
    }
    if (m.t !== "sync") return;
    const e = this.ensure();
    if (e) this.sync(ws, e);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    if (code === 1006 || code === 1015) return;
    try {
      if (code === 1005) ws.close();
      else ws.close(code, "closed");
    } catch {
      // Already closed.
    }
  }

  async webSocketError(): Promise<void> {
    // Nothing to clean up: the runtime drops the socket.
  }

  // ---------- Requests from the router ----------
  async fetch(request: Request): Promise<Response> {
    this.calls++;
    if (this.destroyed || !(await fromInside(request, this.env))) return notFound();
    const owner = request.headers.get("x-scholium-owner") ?? "";
    if (!owner) return notFound();
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (method === "POST" && path === "/internal/init") return await this.init(request, owner);
      const e = this.ensure();
      // A run that belongs to someone else looks exactly like a run that does not exist.
      if (!e || owner !== this.owner) return notFound();
      return await this.route(e, request, url, method, path);
    } catch (err) {
      console.error("run request failed:", method, path, errText(err).slice(0, 300));
      return fail(500, "server_error", "The run could not complete this request.");
    }
  }

  private async init(request: Request, owner: string): Promise<Response> {
    if (this.store.kvGet("meta")) return fail(409, "exists", "This run already exists.");
    const b = await readBody(request);
    const id = String(b.id ?? "");
    if (!/^[a-z0-9]{16,40}$/.test(id)) return fail(400, "bad_request", "The run could not be created.");
    const from = rec(b.branchedFrom);
    let imported: CheckpointExport | undefined;
    let branchedFrom: { runId: string; checkpointId: string } | undefined;
    if (typeof from.runId === "string" && typeof from.checkpointId === "string") {
      const res = await callObject(this.env.RUN, `run:${from.runId}`, this.env, owner, "GET", `/internal/checkpoints/${from.checkpointId}`);
      if (!res.ok) return fail(404, "not_found", "That checkpoint could not be found.");
      imported = (await res.json()) as CheckpointExport;
      branchedFrom = { runId: from.runId, checkpointId: from.checkpointId };
    }
    this.owner = owner;
    this.runId = id;
    const e = this.build();
    try {
      e.init({ id, ownerHash: owner, config: b.config ?? imported?.config, origin: typeof b.origin === "string" ? b.origin : undefined, import: imported, branchedFrom });
    } catch (err) {
      return fail(400, "bad_config", errText(err).slice(0, 300));
    }
    this.store.kvSet("meta", { id, owner });
    this.engine = e;
    if (imported && branchedFrom) await this.pull(e, branchedFrom.runId, imported);
    e.flush();
    await this.report();
    return json({ id, run: e.publicRun() }, 201);
  }

  /** Copies the source texts and uploaded files a branch inherits from the run it was branched from. */
  private async pull(e: Engine, fromRun: string, imp: CheckpointExport): Promise<void> {
    const src = (method: string, path: string, body?: unknown): Promise<Response> => callObject(this.env.RUN, `run:${fromRun}`, this.env, this.owner, method, path, body);
    let ids = (imp.entities.source ?? []).map((s) => s.id);
    for (let guard = 0; ids.length && guard < 200; guard++) {
      try {
        const r = await src("POST", "/internal/pull-texts", { ids });
        if (!r.ok) break;
        const out = rec(await r.json());
        for (const [sid, text] of Object.entries(rec(out.texts))) if (typeof text === "string" && text) e.importText(sid, text);
        ids = Array.isArray(out.rest) ? out.rest.map(String) : [];
      } catch {
        break;
      }
    }
    for (const u of imp.entities.upload ?? []) {
      try {
        const r = await src("GET", `/internal/pull-blob/${u.id}`);
        if (r.ok) e.importBlob(u.id, new Uint8Array(await r.arrayBuffer()));
      } catch {
        // The branch still has the upload's extracted text; only the original file is missing.
      }
    }
  }

  private async route(e: Engine, request: Request, url: URL, method: string, path: string): Promise<Response> {
    const done = (r: ActionResult & Record<string, unknown>, status = 200): Response => {
      if (!r.ok) return fail(409, "refused", r.error);
      this.queueReport();
      void this.tick();
      return json(r, status);
    };
    const q = (k: string): string => url.searchParams.get(k) ?? "";
    let m: RegExpExecArray | null;

    if (method === "GET") {
      if (path === "/internal/exists") return json({ ok: true });
      if (path === "/internal/snapshot") return json({ entities: e.publicSnapshot(), events: this.store.loadEvents(300) });
      if (path === "/internal/calls") return json({ calls: e.calls() });
      if (path === "/internal/text") {
        const text = e.text(q("ref").slice(0, 200));
        return text === null ? notFound() : json({ ref: q("ref").slice(0, 200), text });
      }
      if (path === "/internal/search") return json({ hits: q("q").trim() ? e.search(q("q").slice(0, 300), 40) : [] });
      if (path === "/internal/export") {
        const f = q("format");
        return f === "md" || f === "tex" || f === "json" ? json(e.export(f)) : fail(400, "bad_request", "Choose md, tex or json.");
      }
      if (path === "/internal/entity") {
        const kind = q("kind");
        if (!(ENTITY_KINDS as string[]).includes(kind)) return notFound();
        const data = kind === "run" ? e.publicRun() : (e.m[kind as EntityKind] as Map<string, unknown>).get(q("id"));
        return data ? json({ kind, id: q("id"), data }) : notFound();
      }
      if (path === "/internal/ws") return this.openSocket(e, request);
      if ((m = new RegExp(`^/internal/uploads/${ID}/file$`).exec(path))) {
        const up = e.m.upload.get(m[1]);
        const bytes = e.uploadBytes(m[1]);
        if (!up || !bytes) return notFound();
        // Uploaded files are untrusted: always a download, never something the browser renders.
        return new Response(bytes, { headers: { "content-type": "application/octet-stream", "content-disposition": attachment(up.name) } });
      }
      if ((m = new RegExp(`^/internal/tasks/${ID}/messages$`).exec(path))) {
        const t = e.transcript(m[1]);
        if (!t) return notFound();
        const msgs = t.msgs.map((msg) => {
          const c: Record<string, unknown> = { ...msg };
          delete c.raw;
          return c;
        });
        return json({ task: t.task, msgs });
      }
      if ((m = new RegExp(`^/internal/checkpoints/${ID}$`).exec(path))) {
        const cp = e.exportCheckpoint(m[1]);
        return cp ? json(cp) : notFound();
      }
      if ((m = new RegExp(`^/internal/pull-blob/${ID}$`).exec(path))) {
        const bytes = e.uploadBytes(m[1]);
        return bytes ? new Response(bytes, { headers: { "content-type": "application/octet-stream" } }) : notFound();
      }
      return notFound();
    }

    if (method === "POST" && path === "/internal/uploads") {
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return fail(400, "bad_request", "The upload could not be read.");
      }
      const file = form.get("file");
      if (!file || typeof file === "string") return fail(400, "bad_request", "Choose a file to upload.");
      const text = form.get("text");
      const pages = Number(form.get("pages") ?? "");
      const r = await e.addUpload({
        name: file.name.slice(0, 200),
        mime: file.type || "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
        text: typeof text === "string" && text ? text.slice(0, 2_000_000) : undefined,
        pages: Number.isFinite(pages) && pages > 0 ? Math.floor(pages) : undefined,
      });
      return done(r, 201);
    }

    const b = method === "DELETE" ? {} : await readBody(request);

    if (method === "POST" && path === "/internal/action") {
      const kind = String(b.kind ?? "");
      if (kind !== "start" && kind !== "pause" && kind !== "resume" && kind !== "stop") return fail(400, "bad_request", "Unknown action.");
      if (kind === "start" || kind === "resume") {
        const denied = await this.grant(e);
        if (denied) return fail(409, "budget", denied);
      }
      const r = await e.action(kind);
      return done(r.ok ? { ok: true, run: e.publicRun() } : r);
    }
    if (method === "PUT" && path === "/internal/config") {
      const before = e.run.config.limits.spendUsd;
      const r = e.updateConfig(b.config ?? b);
      if (r.ok && e.run.status === "running" && e.run.config.limits.spendUsd > before) {
        const denied = await this.grant(e);
        if (denied) {
          e.updateConfig({ limits: { spendUsd: before } });
          return fail(409, "budget", denied);
        }
      }
      return done(r.ok ? { ok: true, run: e.publicRun() } : r);
    }
    if (method === "POST" && path === "/internal/instructions") return done(e.addInstruction(String(b.body ?? "").slice(0, 20_000), typeof b.target === "string" ? b.target.slice(0, 64) : "all"), 201);
    if (method === "POST" && path === "/internal/instructions/reorder") return done(e.reorderInstructions(Array.isArray(b.ids) ? b.ids.map(String).slice(0, 500) : []));
    if ((m = new RegExp(`^/internal/instructions/${ID}$`).exec(path))) {
      if (method === "PUT") return done(e.editInstruction(m[1], String(b.body ?? "").slice(0, 20_000)));
      if (method === "DELETE") return done(e.cancelInstruction(m[1]));
    }
    if (method === "POST" && path === "/internal/pull-texts") {
      const texts: Record<string, string> = {};
      const rest: string[] = [];
      let size = 0;
      for (const id of Array.isArray(b.ids) ? b.ids.map(String) : []) {
        if (size > 3_000_000) {
          rest.push(id);
          continue;
        }
        texts[id] = e.sourceText(id);
        size += texts[id].length;
      }
      return json({ texts, rest });
    }
    if (method === "POST" && path === "/internal/destroy") return this.destroy(e);
    return notFound();
  }

  private openSocket(e: Engine, request: Request): Response {
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return fail(426, "upgrade_required", "This address only accepts a live connection.");
    // Each ticket opens one connection, once.
    const nonce = request.headers.get("x-scholium-nonce") ?? "";
    if (!nonce || this.store.kvGet(`nonce:${nonce}`) !== undefined) return fail(401, "invalid_ticket", "This live connection was not authorised. Request a new ticket.");
    const now = Date.now();
    for (const old of this.store.kvPrefix<number>("nonce:")) if (now - old.v > 4 * WS_TICKET_TTL_MS) this.store.kvDel(old.k);
    this.store.kvSet(`nonce:${nonce}`, now);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    this.sync(pair[1], e);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async destroy(e: Engine): Promise<Response> {
    try {
      await e.action("stop");
    } catch {
      // Being deleted regardless.
    }
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.timer = this.reportTimer = null;
    await Promise.race([e.idle(), new Promise((r) => setTimeout(r, 4000))]);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4001, "This run was deleted.");
      } catch {
        // Already closed.
      }
    }
    this.engine = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return json({ ok: true });
  }
}
