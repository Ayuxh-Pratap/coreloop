/**
 * A surface's end of the connection: serves any Surface object to a core over the loopback WebSocket. It uses
 * only the standard WebSocket API (global in Node 24 and in browsers), so the same code can run in a browser
 * extension or a Next.js app.
 *
 *   const conn = await serveSurface(desktop, { url: "ws://127.0.0.1:7777", token });
 *   …
 *   conn.close();
 */
import { PlanError, type Surface } from "./contract.ts";
import { PROTOCOL_VERSION, type Call, type Hello, type Result } from "./protocol.ts";

/** Where the core is, and how to join it. */
export interface ServeOptions {
  /** The core's address: `ws://127.0.0.1:<port>`. */
  url: string;
  /** This launch's token, from the core. */
  token: string;
  /** The place this surface lives in ("Brave" for a browser extension). Overrides the surface's own `inside`. */
  inside?: string;
  /** How long to wait for the core's welcome, in milliseconds. Default 3000. */
  timeoutMs?: number;
}

/** A surface's connection to a core. */
export interface SurfaceConnection {
  /** Closes it. */
  close(): void;
  /** Resolves when the connection ends, with the core's close code and reason. */
  readonly closed: Promise<{ code: number; reason: string }>;
}

/**
 * Serves a surface to a running core over a loopback WebSocket, from another process: a browser extension or another
 * app. It uses only the standard `WebSocket`, so it runs in Node and in a browser. Resolves once the core welcomes it.
 *
 * @example
 * const conn = await serveSurface(new TasksSurface(), { url: "ws://127.0.0.1:7777", token });
 * await conn.closed; // the core's close code and reason
 */
export function serveSurface(surface: Surface, opts: ServeOptions): Promise<SurfaceConnection> {
  const ws = new WebSocket(opts.url);
  const send = (m: Hello | Result) => ws.send(JSON.stringify(m));
  let welcomed = false;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason })));

  async function answer(call: Call): Promise<void> {
    const reply = (r: { ok: true; value: unknown } | { ok: false; error: { kind: "plan" | "error"; message: string } }) =>
      send({ type: "result", id: call.id!, token: opts.token, ...r } as Result);
    try {
      if (call.method === "view") reply({ ok: true, value: await surface.view() });
      else if (call.method === "plan") reply({ ok: true, value: await surface.plan(call.params!.action!, call.params?.assume) });
      else if (call.method === "run") reply({ ok: true, value: await surface.run(call.params!.plan!) });
    } catch (err) {
      reply({ ok: false, error: { kind: err instanceof PlanError ? "plan" : "error", message: (err as Error).message } });
    }
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("the core didn't answer the hello"));
    }, opts.timeoutMs ?? 3000);
    ws.addEventListener("open", () => {
      send({ type: "hello", v: PROTOCOL_VERSION, token: opts.token, name: surface.name, skills: [...surface.skills], ...(surface.operations ? { operations: [...surface.operations] } : {}), ...((opts.inside ?? surface.inside) ? { inside: opts.inside ?? surface.inside } : {}) });
    });
    ws.addEventListener("message", (e) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(e.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (m.token !== opts.token) return; // not from this core
      if (m.type === "welcome" && !welcomed) {
        welcomed = true;
        clearTimeout(timer);
        resolve({ close: () => ws.close(1000), closed });
        return;
      }
      if (m.type !== "call" || !welcomed) return;
      const call = m as unknown as Call;
      if (call.method === "prefetch") surface.prefetch?.();
      else void answer(call);
    });
    ws.addEventListener("close", (e) => {
      clearTimeout(timer);
      if (!welcomed) reject(new Error(`the core closed the connection: ${e.code} ${e.reason}`));
    });
    ws.addEventListener("error", () => {
      if (!welcomed) {
        clearTimeout(timer);
        reject(new Error(`can't reach the core at ${opts.url}`));
      }
    });
  });
}
