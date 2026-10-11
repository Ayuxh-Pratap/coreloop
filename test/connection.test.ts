import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { SystemOneClient } from "../src/backends/systemone.ts";
import { Actor } from "../src/live/actor.ts";
import { SimBrowser } from "../src/sim/browser.ts";
import { loadPages } from "../src/sim/fixture.ts";
import { fixtureDesktop } from "../src/sim/fixture.ts";
import { serveSurface, type SurfaceConnection } from "../src/surface/client.ts";
import { conformance, type Check } from "../src/surface/conformance.ts";
import type { Surface } from "../src/surface/contract.ts";
import { PROTOCOL_VERSION } from "../src/surface/protocol.ts";
import { CLOSE, CoreServer, trustedUpgrade } from "../src/host/server.ts";

const pages = loadPages();
const noModel = {
  decide: () => {
    throw new Error("model called");
  },
} as unknown as SystemOneClient;

const open: { server?: CoreServer; conns: SurfaceConnection[] } = { conns: [] };
afterEach(async () => {
  for (const c of open.conns) c.close();
  open.conns = [];
  await open.server?.close();
  open.server = undefined;
});

async function serve(opts: Parameters<typeof CoreServer.start>[0] = {}) {
  open.server = await CoreServer.start({ port: 0, ...opts });
  return { server: open.server, url: `ws://127.0.0.1:${open.server.port}` };
}

async function connect(surface: Surface, server: CoreServer, url: string, inside?: string) {
  const conn = await serveSurface(surface, { url, token: server.token, ...(inside ? { inside } : {}) });
  open.conns.push(conn);
  return conn;
}

const failed = (checks: Check[]) => checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);

/** A raw client, to send what a real surface never would. */
function raw(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  const opened = new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("unexpected-response", (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
    ws.on("error", (e) => reject(e));
  });
  return { ws, closed, opened };
}

describe("the conformance suite", () => {
  it("passes the simulated desktop and browser in-process", async () => {
    const desktop = fixtureDesktop();
    expect(failed(await conformance(desktop, { run: true, observe: () => desktop.log.length }))).toEqual([]);
    const browser = new SimBrowser(pages, "search-results");
    expect(failed(await conformance(browser, { run: true }))).toEqual([]);
  });

  it("passes the simulated desktop over the WebSocket, planning without running anything", async () => {
    const { server, url } = await serve();
    const desktop = fixtureDesktop();
    await connect(desktop, server, url);
    const remote = server.surface();
    expect(failed(await conformance(remote, { observe: () => desktop.log.length }))).toEqual([]);
    expect(desktop.log).toEqual([]);
    expect(failed(await conformance(remote, { run: true }))).toEqual([]);
    expect(desktop.log.length).toBeGreaterThan(0);
  });

  it("passes the desktop and the browser inside Brave, both over the WebSocket, as one", async () => {
    const { server, url } = await serve();
    await connect(new SimBrowser(pages, "example", "Brave"), server, url, "Brave");
    await connect(fixtureDesktop({ open: ["Brave", "Spotify"], foreground: "Brave" }), server, url);
    expect(server.connected().map((s) => s.name)).toEqual(["simulated desktop", "simulated browser"]);
    expect(failed(await conformance(server.surface(), { run: true }))).toEqual([]);
  });

  it("flags a surface that changes things while planning", async () => {
    const desktop = fixtureDesktop();
    const leaky: Surface = { name: "leaky", skills: desktop.skills, view: () => desktop.view(), plan: async (a) => { const p = desktop.plan(a); await desktop.run(p); return p; }, run: (p) => desktop.run(p) };
    expect(failed(await conformance(leaky, { observe: () => desktop.log.length })).join()).toMatch(/changed while planning/);
  });
});

describe("the actor over the WebSocket", () => {
  it("decides, confirms and runs exactly as in-process", async () => {
    const { server, url } = await serve();
    const desktop = fixtureDesktop();
    await connect(desktop, server, url);
    const actor = new Actor({ client: noModel, surface: server.surface() });
    const asked = await actor.handle("close chrome");
    expect(asked.pending?.summary).toBe('close "Inbox - Google Chrome"');
    expect(desktop.log).toEqual([]);
    const done = await actor.handle("confirm");
    expect(done.ran).toBe(true);
    expect(desktop.log).toEqual([{ do: "close", hwnd: 1001, title: "Inbox - Google Chrome" }]);
    const opened = await actor.handle("open calculator");
    expect(opened.ran).toBe(true);
    expect(desktop.log.at(-1)).toEqual({ do: "launch", app: "Calculator" });
  });

  it("reports a plan the surface can't make, and a surface that went away", async () => {
    const { server, url } = await serve();
    const conn = await connect(fixtureDesktop({ open: [] }), server, url);
    const remote = server.surface();
    const actor = new Actor({ client: noModel, surface: remote });
    expect((await actor.handle("close discord")).planError).toBe("Discord isn't open");
    conn.close();
    await conn.closed;
    await expect(remote.view()).rejects.toThrow(/not connected|disconnected/);
  });
});

describe("hardening", () => {
  it("listens on loopback only", async () => {
    await expect(CoreServer.start({ port: 0, host: "0.0.0.0" })).rejects.toThrow(/loopback/);
  });

  it("refuses a browser page's Origin unless it is allowed, and a Host that isn't loopback", () => {
    expect(trustedUpgrade({ host: "127.0.0.1:7777" }, [])).toBe(true);
    expect(trustedUpgrade({ host: "127.0.0.1:7777", origin: "https://evil.example" }, [])).toBe(false);
    expect(trustedUpgrade({ host: "127.0.0.1:7777", origin: "chrome-extension://abc" }, ["chrome-extension://abc"])).toBe(true);
    expect(trustedUpgrade({ host: "evil.example:7777" }, [])).toBe(false);
  });

  it("refuses those connections at the door", async () => {
    const { url } = await serve();
    await expect(raw(url, { Origin: "https://evil.example" }).opened).rejects.toThrow(/refused 401/);
    await expect(raw(url, { Host: "evil.example" }).opened).rejects.toThrow(/refused 401/);
  });

  it("closes a connection with the wrong token, without a hello, or with a broken one", async () => {
    const { server, url } = await serve({ helloTimeoutMs: 200 });
    const wrong = raw(url);
    await wrong.opened;
    wrong.ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, token: "nope", name: "x", skills: [] }));
    expect((await wrong.closed).code).toBe(CLOSE.badToken);

    const silent = raw(url);
    await silent.opened;
    expect((await silent.closed).code).toBe(CLOSE.noHello);

    const broken = raw(url);
    await broken.opened;
    broken.ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, token: server.token, name: "x", skills: [{ id: "s", places: [], actions: [{ id: "s.a", label: "a", what: "a", risk: "whatever", templates: ["a"] }] }] }));
    const c = await broken.closed;
    expect(c.code).toBe(CLOSE.badMessage);
    expect(c.reason).toMatch(/risk/);
    expect(server.connected()).toEqual([]);
  });

  it("closes a connection whose later message lacks the token, or is too big", async () => {
    const { server, url } = await serve();
    const a = raw(url);
    await a.opened;
    a.ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, token: server.token, name: "x", skills: [] }));
    await server.waitFor(1);
    a.ws.send(JSON.stringify({ type: "result", id: 1, ok: true, value: {} }));
    expect((await a.closed).code).toBe(CLOSE.badToken);

    const b = raw(url);
    await b.opened;
    b.ws.send("x".repeat(1_100_000));
    expect([1006, 1009]).toContain((await b.closed).code); // too big: dropped (the server sends 1009 and cuts it)
  });

  it("refuses a view that breaks the contract instead of using it", async () => {
    const { server, url } = await serve();
    const bad: Surface = { name: "bad", skills: [], view: async () => ({ places: "everything" }) as never, plan: () => ({ summary: "x", detail: [] }), run: async () => ({ ok: true }) };
    await connect(bad, server, url);
    await expect(server.surface().view()).rejects.toThrow(/view.places/);
  });
});
