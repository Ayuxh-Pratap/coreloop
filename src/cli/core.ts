/**
 * The core as a server: surfaces in other processes connect over ws://127.0.0.1:7777, and you type commands
 * here, as in `npm run repl`, but every view, plan and run goes over the connection.
 *
 *   npm run core                          wait for one surface, then take commands
 *   npm run core -- --wait 2              wait for two (the desktop and a browser)
 *   npm run core -- --allow-origin chrome-extension://<id>   let that browser extension connect
 *
 * Then, in another terminal: npm run sim-surface (or a real surface on its branch). The port and the per-launch
 * token are written to ~/.coreloop/session.json while the core runs.
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { startDecider } from "../host/decider.ts";
import { config } from "../config.ts";
import { useProfileFiles } from "../host/profile-files.ts";
import { Actor, describe } from "../live/actor.ts";
import { CoreServer, DEFAULT_PORT } from "../host/server.ts";
import { removeSession, SESSION_FILE, writeSession } from "../host/session.ts";

// the person's profile (mishearings, phrases, nicknames, actions turned off), handed to the engine
useProfileFiles();

const { values } = parseArgs({
  options: { port: { type: "string" }, wait: { type: "string", default: "1" }, "allow-origin": { type: "string", multiple: true }, "no-model": { type: "boolean", default: false } },
});

// the model while it answers, code only while it doesn't; --no-model for code only from the start
const client = await startDecider({ noModel: values["no-model"] });

let actor: Actor | undefined;
const server = await CoreServer.start({
  port: values.port ? Number(values.port) : DEFAULT_PORT,
  allowOrigins: values["allow-origin"] ?? [],
  // a surface came or went: a fresh actor over what is connected now
  onChange: () => {
    const names = server.connected().map((s) => s.name);
    actor = names.length ? new Actor({ client, surface: server.surface() }) : undefined;
    console.log(`  surfaces: ${names.length ? names.join(" + ") : "none"}`);
  },
});
writeSession({ port: server.port, token: server.token, pid: process.pid });
const stop = async () => {
  removeSession();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", stop);

console.log(`coreloop core · ws://127.0.0.1:${server.port} · session in ${SESSION_FILE} · waiting for ${values.wait} surface(s)…`);
await server.waitFor(Number(values.wait), 10 * 60_000);

// Line by line, until /quit or the input ends: piped commands run in order, then the core stops cleanly.
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
let inputEnded = false;
rl.on("close", () => (inputEnded = true));
rl.prompt();
for await (const line of rl) {
  const raw = line.trim();
  if (raw === "/quit") break;
  if (raw && !actor) console.log("  no surface is connected");
  else if (raw) {
    try {
      const r = await actor!.handle(raw);
      console.log(`  ${r.outcome.decision.toUpperCase()} · ${r.outcome.reason}`);
      console.log(`  ${r.pending ? "⚠" : r.runError || r.planError ? "✖" : r.ran ? "✔" : "·"} ${describe(r)}`);
    } catch (err) {
      console.log(`  ✖ ${(err as Error).message}`);
    }
  }
  if (!inputEnded) rl.prompt();
}
rl.close();
await stop();
