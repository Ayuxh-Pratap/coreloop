/**
 * The core's end of the connection: surfaces in other processes connect to ws://127.0.0.1:7777 and each
 * becomes a RemoteSurface, the same Surface the actor already talks to in-process.
 *
 * Hardening (from the browser prototype's server):
 *   - binds to loopback only; any other address is refused;
 *   - the Host header must be loopback (blocks DNS rebinding: a site resolving to 127.0.0.1);
 *   - a browser's Origin must be on the allowlist (empty by default), so a web page open in your browser can't
 *     connect and drive your desktop; non-browser clients send no Origin;
 *   - the first message must be a hello with the per-launch token, within 3 s; every later message carries it too;
 *   - text messages only, at most 1 MB; anything malformed closes the connection;
 *   - everything a surface sends is checked (src/surface/protocol.ts) before the core uses it.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { Skill } from "../skills/types.ts";
import { PlanError, type Decided, type Plan, type Receipt, type Surface, type SurfaceView, type Assume } from "../surface/contract.ts";
import { MAX_MESSAGE_BYTES, parseHello, parseMessage, parsePlan, parseReceipt, parseView, PROTOCOL_VERSION, ProtocolError, type Call, type Method } from "../surface/protocol.ts";
import { Surfaces } from "../surface/router.ts";

export const DEFAULT_PORT = 7777;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

/** Close codes a surface sees. */
export const CLOSE = { badToken: 4401, badMessage: 4400, noHello: 4408, replaced: 4409 } as const;

export interface ServerOptions {
  /** Default 7777; 0 picks a free port (tests). */
  port?: number;
  /** Loopback only: "127.0.0.1" (default), "::1" or "localhost". */
  host?: string;
  /** The per-launch secret; a fresh random one by default. */
  token?: string;
  /** Browser origins allowed to connect ("chrome-extension://<id>"). Empty by default. */
  allowOrigins?: readonly string[];
  helloTimeoutMs?: number;
  /** How long a surface may take to answer, per method. */
  timeoutsMs?: Partial<Record<Method, number>>;
  /** Called when a surface connects or goes away. */
  onChange?: () => void;
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The request may open a connection: loopback Host, and an allowed Origin when a browser sends one. */
export function trustedUpgrade(headers: IncomingHttpHeaders, allowOrigins: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(`http://${headers.host ?? ""}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!LOOPBACK.has(host)) return false;
  const origin = headers.origin;
  return origin === undefined || allowOrigins.includes(origin);
}

export class CoreServer {
  readonly token: string;
  readonly port: number;
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly remotes = new Map<WebSocket, RemoteSurface>();
  private readonly opts: ServerOptions;
  private waiters: (() => void)[] = [];

  private constructor(http: Server, wss: WebSocketServer, token: string, port: number, opts: ServerOptions) {
    this.http = http;
    this.wss = wss;
    this.token = token;
    this.port = port;
    this.opts = opts;
    wss.on("connection", (ws) => this.accept(ws));
  }

  static async start(opts: ServerOptions = {}): Promise<CoreServer> {
    const host = opts.host ?? "127.0.0.1";
    if (!LOOPBACK.has(host)) throw new Error(`the core only listens on loopback, not ${host}`);
    const token = opts.token ?? randomBytes(24).toString("hex");
    const allow = opts.allowOrigins ?? [];
    const http = createServer((_req, res) => {
      res.writeHead(426).end(); // WebSocket only
    });
    const wss = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES, verifyClient: ({ req }: { req: IncomingMessage }) => trustedUpgrade(req.headers, allow) });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(opts.port ?? DEFAULT_PORT, host, () => resolve());
    });
    return new CoreServer(http, wss, token, (http.address() as AddressInfo).port, opts);
  }

  /** The surfaces connected now, outermost first (those living inside a place come after; the router chains them). */
  connected(): RemoteSurface[] {
    return [...this.remotes.values()].sort((a, b) => Number(Boolean(a.inside)) - Number(Boolean(b.inside)));
  }

  /** What the actor talks to: the one surface, or all of them through the router. */
  surface(): Surface {
    const list = this.connected();
    if (list.length === 0) throw new Error("no surface is connected");
    return list.length === 1 ? list[0]! : new Surfaces(list);
  }

  /** Resolves once at least `n` surfaces are connected. */
  async waitFor(n: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.remotes.size < n) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`${this.remotes.size} of ${n} surfaces connected`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  async close(): Promise<void> {
    // say goodbye properly, then cut whatever doesn't answer within half a second
    const gone = [...this.wss.clients].map(
      (ws) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            ws.terminate();
            resolve();
          }, 500);
          ws.once("close", () => {
            clearTimeout(t);
            resolve();
          });
          ws.close(1001, "the core stopped");
        }),
    );
    await Promise.all(gone);
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private changed(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
    this.opts.onChange?.();
  }

  private accept(ws: WebSocket): void {
    const timer = setTimeout(() => ws.close(CLOSE.noHello, "no hello"), this.opts.helloTimeoutMs ?? 3000);
    let remote: RemoteSurface | undefined;
    ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) throw new ProtocolError("text messages only");
        const m = parseMessage(data.toString("utf8"));
        if (typeof m.token !== "string" || !sameSecret(m.token, this.token)) {
          ws.close(CLOSE.badToken, "bad token");
          return;
        }
        if (!remote) {
          const hello = parseHello(m);
          clearTimeout(timer);
          remote = new RemoteSurface(ws, hello.name, hello.skills, hello.operations, hello.inside, this.token, this.opts.timeoutsMs);
          this.remotes.set(ws, remote);
          ws.send(JSON.stringify({ type: "welcome", v: PROTOCOL_VERSION, token: this.token }));
          this.changed();
          return;
        }
        remote.receive(m);
      } catch (err) {
        ws.close(CLOSE.badMessage, (err as Error).message.slice(0, 120));
      }
    });
    ws.on("close", () => {
      clearTimeout(timer);
      if (remote) {
        remote.gone();
        this.remotes.delete(ws);
        this.changed();
      }
    });
    ws.on("error", () => ws.terminate());
  }
}

const TIMEOUTS: Record<Method, number> = { view: 2000, plan: 3000, run: 20000 };

/** A surface in another process, as the core sees it: the contract, carried over the connection. */
export class RemoteSurface implements Surface {
  readonly name: string;
  readonly skills: readonly Skill[];
  readonly operations?: readonly string[];
  /** The app it lives in, if any ("Brave"). */
  readonly inside?: string;
  private readonly ws: WebSocket;
  private readonly token: string;
  private readonly timeouts: Record<Method, number>;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private next = 1;
  private closed = false;

  constructor(ws: WebSocket, name: string, skills: readonly Skill[], operations: readonly string[] | undefined, inside: string | undefined, token: string, timeouts?: Partial<Record<Method, number>>) {
    this.ws = ws;
    this.name = name;
    this.skills = skills;
    if (operations) this.operations = operations;
    if (inside) this.inside = inside;
    this.token = token;
    this.timeouts = { ...TIMEOUTS, ...timeouts };
  }

  private call(method: Method, params?: Call["params"]): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`${this.name} is not connected`));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} took too long to ${method}`));
      }, this.timeouts[method]);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: "call", id, token: this.token, method, params } satisfies Call));
    });
  }

  /** A result from the surface (the token was checked by the server). */
  receive(m: Record<string, unknown>): void {
    if (m.type !== "result" || typeof m.id !== "number") throw new ProtocolError("only results are expected");
    const p = this.pending.get(m.id);
    if (!p) return; // late, after a timeout
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok === true) p.resolve(m.value);
    else {
      const e = (m.error ?? {}) as { kind?: unknown; message?: unknown };
      const message = typeof e.message === "string" ? e.message.slice(0, 300) : "the surface failed";
      p.reject(e.kind === "plan" ? new PlanError(message) : new Error(message));
    }
  }

  gone(): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${this.name} disconnected`));
    }
    this.pending.clear();
  }

  async view(): Promise<SurfaceView> {
    return parseView(await this.call("view"));
  }

  prefetch(): void {
    if (!this.closed) this.ws.send(JSON.stringify({ type: "call", token: this.token, method: "prefetch" } satisfies Call));
  }

  async plan(action: Decided, assume?: Assume): Promise<Plan> {
    return parsePlan(await this.call("plan", { action, ...(assume ? { assume } : {}) }));
  }

  async run(plan: Plan): Promise<Receipt> {
    try {
      return parseReceipt(await this.call("run", { plan }));
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
