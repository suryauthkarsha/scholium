// The Worker's front door. It only hands requests to the router, which authorises every one of them
// before anything else happens. Everything that is not under /api/ is a static file of the web app.
import { handle, type RouterEnv } from "../src/server/router";
import { makeVerifier } from "../src/server/verify";
import type { Env } from "./env";

export { ResearchRun } from "./run-do";
export { Workspace } from "./workspace-do";

const verify = makeVerifier();

/** 26 random lower-case letters and digits: about 134 bits. */
function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  let out = "";
  for (const b of bytes) out += "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36];
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const res = await handle(request, env as unknown as RouterEnv, { verify, now: Date.now, randomId });
    return res ?? env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
