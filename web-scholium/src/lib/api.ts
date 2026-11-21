// Every call to the backend goes through here: it attaches the session token, retries once with a renewed token
// after a 401, and turns refusals into errors that carry the server's own wording.
import { AUTH_EVENT, getAccessToken } from "@/hooks/useAuth";
import type { ModelKey } from "@/shared/models";
import type { ActivityEvent, CallRecord, Checkpoint, DiagnosticResult, EntityKind, Msg, RunConfig, RunState, Snapshot, StrategyState, Task, Upload, WorkspaceOverview } from "@/shared/types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public reason?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const FALLBACK: Record<number, string> = {
  401: "Your session has ended. Sign in again.",
  403: "This account is not allowed to use this workspace.",
  404: "That was not found in this workspace.",
  413: "That is larger than the server accepts.",
  429: "Too many requests at once. Try again in a moment.",
  503: "The server is not fully configured yet, so it refused the request.",
};

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  if (!token) throw new ApiError(401, "signed_out", FALLBACK[401]);
  const go = (t: string): Promise<Response> => fetch(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${t}` } });
  let res: Response;
  try {
    res = await go(token);
    if (res.status === 401) {
      const fresh = await getAccessToken(token);
      if (fresh) res = await go(fresh);
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "network", "The server could not be reached. Check the connection and try again.");
  }
  if (res.ok) return res;
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; reason?: string };
  // The provider asks the server again who is signed in, which moves the app to the right screen.
  if (res.status === 401 || res.status === 403) window.dispatchEvent(new Event(AUTH_EVENT));
  throw new ApiError(res.status, body.error ?? String(res.status), body.message ?? FALLBACK[res.status] ?? `The request failed (${res.status}${body.error ? `: ${body.error}` : ""}).`, body.reason);
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { method, signal };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await send(path, init);
  return (await res.json().catch(() => ({}))) as T;
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
const put = <T>(path: string, body: unknown) => request<T>("PUT", path, body);
const q = encodeURIComponent;

export type StrategyView = StrategyState & { policy: string[]; version: string; probes: { id: string; what: string; safety: boolean }[] };
export type StrategyVerb = "propose" | "evaluate" | "adopt" | "reject" | "rollback";
export type RunAction = "start" | "pause" | "resume" | "stop";
export type ExportFormat = "md" | "tex" | "json";

export interface SettingsPatch {
  monthlyCapUsd?: number;
  leanUrl?: string;
  exaKey?: string | null;
  exaFreeConfirmed?: boolean;
  exaEnabled?: boolean;
  exaMonthlyCap?: number;
}

export interface SearchHit {
  id: string;
  kind: string;
  title: string;
  snippet: string;
}

export type RunSnapshot = { entities: Snapshot; events: ActivityEvent[] };
type Done = { ok: boolean; run?: RunState };

const r = (id: string): string => `/api/runs/${q(id)}`;

export const api = {
  // Workspace
  workspace: (signal?: AbortSignal) => get<WorkspaceOverview>("/api/workspace", signal),
  saveSettings: (patch: SettingsPatch) => put<unknown>("/api/workspace/settings", patch),
  diagnostics: (body: { checks?: string[]; models?: ModelKey[] }) => post<{ results: DiagnosticResult[]; at: number }>("/api/workspace/diagnostics", body),
  testEmail: () => post<{ status: string; detail: string; to: string }>("/api/workspace/test-email"),
  strategy: (signal?: AbortSignal) => get<StrategyView>("/api/workspace/strategy", signal),
  strategyAct: (verb: StrategyVerb, body: Record<string, unknown>) => post<StrategyView & { ok: boolean; message?: string }>(`/api/workspace/strategy/${verb}`, body),
  driveStart: () => post<{ url: string }>("/api/drive/start"),
  driveDisconnect: () => post<unknown>("/api/drive/disconnect"),

  // Runs
  createRun: (config: RunConfig) => post<{ id: string; run: RunState }>("/api/runs", { config }),
  snapshot: (id: string, signal?: AbortSignal) => get<RunSnapshot>(r(id), signal),
  deleteRun: (id: string) => request<unknown>("DELETE", r(id)),
  action: (id: string, kind: RunAction) => post<Done>(`${r(id)}/action`, { kind }),
  config: (id: string, patch: Partial<RunConfig>) => put<Done>(`${r(id)}/config`, patch),
  branch: (id: string, checkpointId: string, config?: Partial<RunConfig>) => post<{ id: string; run: RunState }>(`${r(id)}/branch`, { checkpointId, config }),

  // The instruction queue
  instruct: (id: string, body: string, target: string) => post<Done>(`${r(id)}/instructions`, { body, target }),
  editInstruction: (id: string, iid: string, body: string) => put<Done>(`${r(id)}/instructions/${q(iid)}`, { body }),
  cancelInstruction: (id: string, iid: string) => request<Done>("DELETE", `${r(id)}/instructions/${q(iid)}`),
  reorderInstructions: (id: string, ids: string[]) => post<Done>(`${r(id)}/instructions/reorder`, { ids }),

  // Reading
  messages: (id: string, taskId: string, signal?: AbortSignal) => get<{ task: Task; msgs: Msg[] }>(`${r(id)}/tasks/${q(taskId)}/messages`, signal),
  checkpoint: (id: string, cid: string) => get<{ checkpoint?: Checkpoint } & Record<string, unknown>>(`${r(id)}/checkpoints/${q(cid)}`),
  calls: (id: string, signal?: AbortSignal) => get<{ calls: CallRecord[] }>(`${r(id)}/calls`, signal),
  text: (id: string, ref: string, signal?: AbortSignal) => get<{ ref: string; text: string }>(`${r(id)}/text?ref=${q(ref)}`, signal),
  search: (id: string, query: string, signal?: AbortSignal) => get<{ hits: SearchHit[] }>(`${r(id)}/search?q=${q(query)}`, signal),
  entity: (id: string, kind: EntityKind, eid: string) => get<{ kind: EntityKind; id: string; data: unknown }>(`${r(id)}/entity?kind=${q(kind)}&id=${q(eid)}`),
  exportRun: (id: string, format: ExportFormat) => get<{ filename: string; mime: string; content: string }>(`${r(id)}/export?format=${format}`),
  wsTicket: (id: string) => post<{ ticket: string; expiresInMs: number }>(`${r(id)}/ws-ticket`),

  /** Uploads one file. `text` is what the browser could read out of it (PDF text, for instance); the server treats it as untrusted. */
  upload: (id: string, file: File, text?: string, pages?: number) => {
    const form = new FormData();
    form.set("file", file, file.name);
    if (text) form.set("text", text);
    if (pages) form.set("pages", String(pages));
    return request<Done & { upload?: Upload }>("POST", `${r(id)}/uploads`, form);
  },

  /** Fetches a stored upload with the session token and hands it to the browser as a download. */
  downloadUpload: async (id: string, upload: Pick<Upload, "id" | "name">) => {
    const res = await send(`${r(id)}/uploads/${q(upload.id)}/file`);
    saveBlob(await res.blob(), upload.name);
  },
};

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const saveText = (content: string, filename: string, mime: string): void => saveBlob(new Blob([content], { type: `${mime};charset=utf-8` }), filename);

/** The live stream of one run. A fresh single-use ticket is required for every connection. */
// A host that serves only the pages (Vercel) forwards /api to the backend but cannot carry a live connection,
// so there the stream goes straight to the backend named by VITE_BACKEND_ORIGIN. The ticket is still what authorises it.
const BACKEND_ORIGIN = ((import.meta.env.VITE_BACKEND_ORIGIN as string | undefined) ?? "").trim().replace(/\/+$/, "");
export const socketUrl = (id: string, ticket: string): string => `${(/^https:\/\/[^/]+$/.test(BACKEND_ORIGIN) ? BACKEND_ORIGIN : window.location.origin).replace(/^http/, "ws")}${r(id)}/ws?ticket=${q(ticket)}`;

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
