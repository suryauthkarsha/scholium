// The run's storage: the engine's `Store` on a Durable Object's own SQLite database.
// Every statement is synchronous, so a group of writes inside `transaction` is atomic.
import type { SearchHit, Store, StoredEntity } from "../src/engine/store";
import { keyTerms } from "../src/engine/util";
import type { ActivityEvent, EntityKind, Msg } from "../src/shared/types";

const CHUNK = 400_000;
const TEXT_CHUNK = 300_000;
const BLOB_CHUNK = 1_000_000;
const FTS_CHUNK = 200_000;
const KEEP_EVENTS = 5000;

type Row = Record<string, unknown>;

export class SqlStore implements Store {
  /** Rows written and read since this object woke up, for the free-allowance guard. */
  written = 0;
  read = 0;
  private fts = true;
  private appended = 0;

  constructor(private storage: DurableObjectStorage) {
    this.q("CREATE TABLE IF NOT EXISTS ent (kind TEXT NOT NULL, id TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, id, part)) WITHOUT ROWID");
    this.q("CREATE TABLE IF NOT EXISTS msg (task TEXT NOT NULL, idx INTEGER NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (task, idx, part)) WITHOUT ROWID");
    this.q("CREATE TABLE IF NOT EXISTS ev (seq INTEGER PRIMARY KEY, data TEXT NOT NULL)");
    this.q("CREATE TABLE IF NOT EXISTS txt (ref TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (ref, part)) WITHOUT ROWID");
    this.q("CREATE TABLE IF NOT EXISTS blob (ref TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (ref, part)) WITHOUT ROWID");
    this.q("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID");
    try {
      this.q("CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(title, body, ref UNINDEXED, kind UNINDEXED)");
      this.q("CREATE TABLE IF NOT EXISTS ftsmap (ref TEXT NOT NULL, rid INTEGER NOT NULL, PRIMARY KEY (ref, rid)) WITHOUT ROWID");
    } catch {
      this.fts = false;
      this.q("CREATE TABLE IF NOT EXISTS doc (ref TEXT NOT NULL, part INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (ref, part)) WITHOUT ROWID");
    }
  }

  private q(query: string, ...bindings: unknown[]): Row[] {
    const cursor = this.storage.sql.exec(query, ...bindings);
    const rows = cursor.toArray() as Row[];
    this.read += cursor.rowsRead;
    this.written += cursor.rowsWritten;
    return rows;
  }

  private putParts(table: "ent" | "txt", where: string, keys: unknown[], text: string, size: number): void {
    const n = Math.max(1, Math.ceil(text.length / size));
    for (let i = 0; i < n; i++) this.q(`INSERT OR REPLACE INTO ${table} VALUES (${keys.map(() => "?").join(",")}, ?, ?)`, ...keys, i, text.slice(i * size, (i + 1) * size));
    this.q(`DELETE FROM ${table} WHERE ${where} AND part >= ?`, ...keys, n);
  }

  loadEntities(): StoredEntity[] {
    const out: StoredEntity[] = [];
    let cur: { kind: string; id: string; text: string } | null = null;
    const push = (): void => {
      if (!cur) return;
      try {
        out.push({ kind: cur.kind as EntityKind, id: cur.id, data: JSON.parse(cur.text) });
      } catch {
        // A row that cannot be parsed is skipped rather than stopping the run from loading.
      }
    };
    for (const r of this.q("SELECT kind, id, data FROM ent ORDER BY kind, id, part")) {
      const kind = String(r.kind);
      const id = String(r.id);
      if (cur && cur.kind === kind && cur.id === id) cur.text += String(r.data);
      else {
        push();
        cur = { kind, id, text: String(r.data) };
      }
    }
    push();
    return out;
  }

  putEntity(kind: EntityKind, id: string, data: unknown): void {
    this.putParts("ent", "kind = ? AND id = ?", [kind, id], JSON.stringify(data), CHUNK);
  }

  delEntity(kind: EntityKind, id: string): void {
    this.q("DELETE FROM ent WHERE kind = ? AND id = ?", kind, id);
  }

  loadMsgs(taskId: string): Msg[] {
    const out: Msg[] = [];
    let idx = -1;
    let text = "";
    const push = (): void => {
      if (idx < 0) return;
      try {
        out.push(JSON.parse(text) as Msg);
      } catch {
        out.push({ role: "user", text: "[A stored message could not be read back.]", origin: "system" });
      }
    };
    for (const r of this.q("SELECT idx, data FROM msg WHERE task = ? ORDER BY idx, part", taskId)) {
      const i = Number(r.idx);
      if (i === idx) text += String(r.data);
      else {
        push();
        idx = i;
        text = String(r.data);
      }
    }
    push();
    return out;
  }

  writeMsgs(taskId: string, from: number, msgs: Msg[]): void {
    this.q("DELETE FROM msg WHERE task = ? AND idx >= ?", taskId, from);
    msgs.forEach((m, k) => {
      const text = JSON.stringify(m);
      const n = Math.max(1, Math.ceil(text.length / CHUNK));
      for (let i = 0; i < n; i++) this.q("INSERT OR REPLACE INTO msg VALUES (?, ?, ?, ?)", taskId, from + k, i, text.slice(i * CHUNK, (i + 1) * CHUNK));
    });
  }

  appendEvent(e: ActivityEvent): void {
    this.q("INSERT OR REPLACE INTO ev VALUES (?, ?)", e.seq, JSON.stringify(e));
    if (++this.appended % 250 === 0) this.q("DELETE FROM ev WHERE seq < ?", e.seq - KEEP_EVENTS);
  }

  loadEvents(limit: number): ActivityEvent[] {
    const out: ActivityEvent[] = [];
    for (const r of this.q("SELECT data FROM ev ORDER BY seq DESC LIMIT ?", limit)) {
      try {
        out.push(JSON.parse(String(r.data)) as ActivityEvent);
      } catch {
        // skip
      }
    }
    return out.reverse();
  }

  putText(ref: string, text: string): void {
    if (!text) this.q("DELETE FROM txt WHERE ref = ?", ref);
    else this.putParts("txt", "ref = ?", [ref], text, TEXT_CHUNK);
  }

  getText(ref: string): string | null {
    const rows = this.q("SELECT data FROM txt WHERE ref = ? ORDER BY part", ref);
    return rows.length ? rows.map((r) => String(r.data)).join("") : null;
  }

  putBlob(ref: string, bytes: Uint8Array): void {
    this.q("DELETE FROM blob WHERE ref = ?", ref);
    for (let i = 0, part = 0; i < bytes.length; i += BLOB_CHUNK, part++) {
      const piece = bytes.slice(i, i + BLOB_CHUNK);
      this.q("INSERT INTO blob VALUES (?, ?, ?)", ref, part, piece.buffer);
    }
  }

  getBlob(ref: string): Uint8Array | null {
    const rows = this.q("SELECT data FROM blob WHERE ref = ? ORDER BY part", ref);
    if (!rows.length) return null;
    const parts = rows.map((r) => new Uint8Array(r.data as ArrayBuffer));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  indexDoc(ref: string, kind: string, title: string, text: string): void {
    if (!this.fts) {
      this.q("DELETE FROM doc WHERE ref = ?", ref);
      const n = text || title ? Math.max(1, Math.ceil(text.length / FTS_CHUNK)) : 0;
      for (let i = 0; i < n; i++) this.q("INSERT INTO doc VALUES (?, ?, ?, ?, ?)", ref, i, kind, title, text.slice(i * FTS_CHUNK, (i + 1) * FTS_CHUNK));
      return;
    }
    for (const r of this.q("SELECT rid FROM ftsmap WHERE ref = ?", ref)) this.q("DELETE FROM fts WHERE rowid = ?", Number(r.rid));
    this.q("DELETE FROM ftsmap WHERE ref = ?", ref);
    if (!text && !title) return;
    const n = Math.max(1, Math.ceil(text.length / FTS_CHUNK));
    for (let i = 0; i < n; i++) {
      this.q("INSERT INTO fts (title, body, ref, kind) VALUES (?, ?, ?, ?)", title, text.slice(i * FTS_CHUNK, (i + 1) * FTS_CHUNK), ref, kind);
      const rid = Number(this.q("SELECT last_insert_rowid() AS rid")[0]?.rid ?? 0);
      if (rid) this.q("INSERT OR REPLACE INTO ftsmap VALUES (?, ?)", ref, rid);
    }
  }

  search(query: string, limit: number, kinds?: string[]): SearchHit[] {
    const terms = (keyTerms(query).length ? keyTerms(query) : query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1)).slice(0, 12).map((t) => t.replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean);
    if (!terms.length) return [];
    const kindSql = kinds?.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
    const seen = new Set<string>();
    const out: SearchHit[] = [];
    if (this.fts) {
      const match = terms.map((t) => `"${t}"*`).join(" OR ");
      let rows: Row[] = [];
      try {
        rows = this.q(`SELECT ref, kind, title, snippet(fts, 1, '', '', ' … ', 28) AS snip, bm25(fts, 4.0, 1.0) AS rank FROM fts WHERE fts MATCH ?${kindSql} ORDER BY rank LIMIT ?`, match, ...(kinds ?? []), limit * 3);
      } catch {
        rows = [];
      }
      for (const r of rows) {
        const ref = String(r.ref);
        if (seen.has(ref)) continue;
        seen.add(ref);
        out.push({ ref, kind: String(r.kind), title: String(r.title), snippet: String(r.snip ?? ""), score: -Number(r.rank ?? 0) });
        if (out.length >= limit) break;
      }
      return out;
    }
    const like = terms.map(() => "(lower(title) LIKE ? OR lower(body) LIKE ?)").join(" OR ");
    const args = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
    for (const r of this.q(`SELECT ref, kind, title, body FROM doc WHERE (${like})${kindSql} LIMIT ?`, ...args, ...(kinds ?? []), limit * 4)) {
      const ref = String(r.ref);
      if (seen.has(ref)) continue;
      seen.add(ref);
      const body = String(r.body);
      const low = `${String(r.title)} ${body}`.toLowerCase();
      const at = Math.max(0, body.toLowerCase().indexOf(terms[0]) - 80);
      out.push({ ref, kind: String(r.kind), title: String(r.title), snippet: body.slice(at, at + 240), score: terms.filter((t) => low.includes(t)).length });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  transaction(fn: () => void): void {
    this.storage.transactionSync(fn);
  }

  // ---- A small key-value table for the object's own bookkeeping (not part of the engine's Store). ----
  kvGet<T>(k: string): T | undefined {
    const r = this.q("SELECT v FROM kv WHERE k = ?", k)[0];
    if (!r) return undefined;
    try {
      return JSON.parse(String(r.v)) as T;
    } catch {
      return undefined;
    }
  }

  kvSet(k: string, v: unknown): void {
    this.q("INSERT OR REPLACE INTO kv VALUES (?, ?)", k, JSON.stringify(v));
  }

  kvDel(k: string): void {
    this.q("DELETE FROM kv WHERE k = ?", k);
  }

  kvPrefix<T>(prefix: string): { k: string; v: T }[] {
    const out: { k: string; v: T }[] = [];
    for (const r of this.q("SELECT k, v FROM kv WHERE k >= ? AND k < ? ORDER BY k", prefix, `${prefix}\uffff`)) {
      try {
        out.push({ k: String(r.k), v: JSON.parse(String(r.v)) as T });
      } catch {
        // skip
      }
    }
    return out;
  }
}
