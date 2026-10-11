/**
 * Type commands and watch the core handle them on the simulated desktop: the same actor as `npm run live`, minus
 * the microphone. Nothing on this machine changes; each plan runs on the simulation, so the next command sees
 * what the last one did (open Spotify, then "search for panther" searches in Spotify).
 *
 *   npm run repl                                          the fixture desktop (VS Code in front)
 *   npm run repl -- --open "Cursor,Spotify" --front Cursor --host Cursor
 *   npm run repl -- "open spotify" "search for panther"   run these, then exit
 *   /windows                                              what's open, top first
 *
 * A destructive action shows its exact plan and waits; "confirm" runs that same plan, "cancel" drops it. Every
 * utterance, decision, plan and result is recorded to runs/<time>/.
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { CODE_ONLY } from "../backends/codeonly.ts";
import { SystemOneError } from "../backends/systemone.ts";
import { startDecider } from "../host/decider.ts";
import { config } from "../config.ts";
import { useProfileFiles } from "../host/profile-files.ts";
import { Actor, describe } from "../live/actor.ts";
import { Recorder } from "../recorder/recorder.ts";
import { fixtureDesktop } from "../sim/fixture.ts";

// the person's profile (mishearings, phrases, nicknames, actions turned off), handed to the engine
useProfileFiles();

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { open: { type: "string" }, front: { type: "string" }, host: { type: "string" }, "no-model": { type: "boolean", default: false } },
});

// the model while it answers, code only while it doesn't; --no-model for code only from the start
const client = await startDecider({ noModel: values["no-model"] });
const open = values.open?.split(",").map((s) => s.trim()).filter(Boolean);
const sim = fixtureDesktop(open ? { open, foreground: values.front ?? open[0], host: values.host } : undefined);
const actor = new Actor({ client, surface: sim });
const rec = new Recorder("runs", { source: "repl", surface: sim.name, apps: sim.apps.length });

const windows = () => sim.windows.map((w) => `${w === sim.foreground ? "▶ " : "  "}${w.title}${w.minimized ? " (minimized)" : ""}`).join("\n    ");

async function handle(raw: string): Promise<void> {
  if (raw === "/windows") {
    console.log(`    ${windows()}`);
    return;
  }
  rec.event("utterance", { raw });
  const r = await actor.handle(raw);
  sim.afterTurn();
  const u = r.understood;
  // without the model (or while it is down) the decider answers nothing: that turn is code only, not a 0 ms model call
  const model = u.decision?.model === CODE_ONLY ? undefined : u.decision;
  rec.event("outcome", { text: u.norm.text, ...r.outcome, modelMs: model ? Math.round(model.latencyMs) : 0 });
  if (r.plan) rec.event(r.pending ? "pending" : "plan", { summary: r.plan.summary, detail: r.plan.detail });
  if (r.runError || r.planError) rec.event("action_error", { message: r.runError ?? r.planError });

  const target = u.scope.target ? ` · for ${u.scope.target.app} (${u.scope.target.via})` : "";
  console.log(`  ${r.outcome.decision.toUpperCase()} · ${r.outcome.reason}${target} · ${model ? `${model.latencyMs.toFixed(0)} ms` : "code only"}`);
  if (r.plan && r.plan.detail.length > 1) console.log(`  steps: ${r.plan.detail.join(" · ")}`);
  console.log(`  ${r.pending ? "⚠" : r.runError || r.planError ? "✖" : r.ran ? "✔" : "·"} ${describe(r)}`);
}

try {
  console.log(`coreloop repl · ${sim.name} · ${sim.apps.length} apps · in front: ${sim.foreground?.title ?? "nothing"}${sim.host ? ` · coreloop runs inside ${sim.host}` : ""} · /windows, /quit`);
  if (positionals.length) {
    for (const raw of positionals) {
      console.log(`› ${raw}`);
      await handle(raw);
    }
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      const raw = (await rl.question("› ")).trim();
      if (raw === "/quit" || raw === "/exit") break;
      if (raw) await handle(raw);
    }
    rl.close();
  }
} catch (err) {
  console.error(err instanceof SystemOneError ? `${err.code}: ${err.message}` : err);
  process.exitCode = 1;
} finally {
  console.log(`recorded: ${rec.dir}`);
}
