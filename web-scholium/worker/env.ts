// Bindings and secrets the Worker and its Durable Objects receive, and the one way they talk to each other.
import { internalKey, timingSafeEqual } from "../src/shared/gate";

export interface Env {
  ASSETS: Fetcher;
  RUN: DurableObjectNamespace;
  WORKSPACE: DurableObjectNamespace;
  /** Signs tickets and protects object-to-object calls. */
  SCHOLIUM_SECRET: string;
  /** Rork AI Cloud credential. Server-side only: it is never sent to the browser or to a sandbox. */
  EXPO_PUBLIC_RORK_TOOLKIT_SECRET_KEY: string;
  ALERT_EMAIL_TO?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  /** Optional free Stack Exchange app key; raises the daily request allowance. */
  STACKEXCHANGE_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RORK_AUTH_SECRET_KEY?: string;
  RORK_AUTH_URL?: string;
}

export const INTERNAL = "https://scholium.internal";

export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
export const fail = (status: number, error: string, message: string): Response => json({ error, message }, status);
export const notFound = (): Response => fail(404, "not_found", "There is nothing at this address.");
export const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** True when the request carries the key only the router and sibling objects can compute. */
export async function fromInside(request: Request, env: Env): Promise<boolean> {
  const key = request.headers.get("x-scholium-key");
  if (!key || !env.SCHOLIUM_SECRET) return false;
  return timingSafeEqual(key, await internalKey(env.SCHOLIUM_SECRET));
}

/** Calls another object the way the router does. */
export async function callObject(ns: DurableObjectNamespace, name: string, env: Env, ownerHash: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "x-scholium-key": await internalKey(env.SCHOLIUM_SECRET), "x-scholium-owner": ownerHash };
  if (body === undefined) return ns.getByName(name).fetch(`${INTERNAL}${path}`, { method, headers });
  headers["content-type"] = "application/json";
  return ns.getByName(name).fetch(`${INTERNAL}${path}`, { method, headers, body: JSON.stringify(body) });
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return rec(await request.json());
  } catch {
    return {};
  }
}
