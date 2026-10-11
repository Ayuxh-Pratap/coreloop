/**
 * The simulated desktop as a surface in its own process: connects to a running core (`npm run core`) and
 * prints every step the core makes it run. Nothing on this machine changes.
 *
 *   npm run sim-surface                              the fixture desktop
 *   npm run sim-surface -- --browser search-results  plus the simulated browser inside Brave, on that page
 */
import { parseArgs } from "node:util";
import { SimBrowser } from "../sim/browser.ts";
import { loadPages } from "../sim/fixture.ts";
import { fixtureDesktop } from "../sim/fixture.ts";
import { serveSurface } from "../surface/client.ts";
import type { Plan, Receipt, Surface } from "../surface/contract.ts";
import { readSession, SESSION_FILE } from "../host/session.ts";

const { values } = parseArgs({ options: { browser: { type: "string" }, url: { type: "string" }, token: { type: "string" } } });
const session = readSession();
const url = values.url ?? (session ? `ws://127.0.0.1:${session.port}` : undefined);
const token = values.token ?? session?.token;
if (!url || !token) {
  console.error(`no running core found (${SESSION_FILE}). Start it first: npm run core`);
  process.exit(1);
}

/** The same surface, saying what it runs. */
function loud<S extends Surface>(s: S): S {
  const run = s.run.bind(s);
  s.run = async (plan: Plan): Promise<Receipt> => {
    console.log(`  ${s.name}: ${plan.summary}${plan.detail.length ? `  [${plan.detail.join(" · ")}]` : ""}`);
    return run(plan);
  };
  return s;
}

const desktop = loud(fixtureDesktop(values.browser ? { open: ["Brave", "Visual Studio Code", "Terminal", "Spotify"], foreground: "Brave" } : undefined));
const conns = [await serveSurface(desktop, { url, token })];
if (values.browser) conns.push(await serveSurface(loud(new SimBrowser(loadPages(), values.browser, "Brave")), { url, token, inside: "Brave" }));
console.log(`connected to ${url}: ${values.browser ? "simulated desktop + simulated browser (inside Brave)" : "simulated desktop"}. Ctrl+C to stop.`);
const end = await Promise.race(conns.map((c) => c.closed));
console.log(`the core closed the connection (${end.code}${end.reason ? ` ${end.reason}` : ""})`);
for (const c of conns) c.close();
