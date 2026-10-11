/**
 * Runs typed text through the whole pipeline (normalise → model → policy) and prints the outcome, WITHOUT
 * acting. Each call is recorded to runs/<time>/ (see `npm run last-run`).
 *
 *   npm run say -- "um can you open spotify please"
 *   npm run say -- "close chrome" "confirm"          several utterances, one session (pending confirms carry over)
 *   npm run say -- --with-is-command "paste hello"   also ask the separate is_command gate
 *   npm run say -- --no-model "open spotify"         code only: what code decides is done, the rest gets a question
 */
import { parseArgs } from "node:util";
import { CODE_ONLY, CodeOnlyDecider } from "../backends/codeonly.ts";
import { SystemOneClient, SystemOneError, type Decider } from "../backends/systemone.ts";
import { config } from "../config.ts";
import { useProfileFiles } from "../host/profile-files.ts";
import { understand } from "../core/pipeline.ts";
import { Session, type Outcome } from "../core/policy.ts";
import { Recorder } from "../recorder/recorder.ts";

// the person's profile (mishearings, phrases, nicknames, actions turned off), handed to the engine
useProfileFiles();

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "with-is-command": { type: "boolean", default: false }, "no-model": { type: "boolean", default: false } },
});
if (positionals.length === 0) {
  console.error('usage: npm run say -- "open spotify" ["confirm" …] [--with-is-command] [--no-model]');
  process.exit(2);
}

// --no-model: code only from the start. Without it the model must be up: say measures it, so it never falls back.
const noModel = values["no-model"];
if (noModel && values["with-is-command"]) {
  console.error("--with-is-command asks the model, so it can't be used with --no-model");
  process.exit(2);
}
let client: Decider;
if (noModel) {
  console.error("no-model mode: code decides what it can and asks about the rest");
  client = new CodeOnlyDecider();
} else {
  const http = new SystemOneClient({ baseUrl: config.decider.url, timeoutMs: config.decider.timeoutMs });
  if (!(await http.health()).ok) {
    console.error(`model server not reachable at ${config.decider.url}. Start it: npm run models:start, or run without it: --no-model`);
    process.exit(1);
  }
  client = http;
}
const isCommand = values["with-is-command"];
const rec = new Recorder("runs", { source: "say", isCommand, model: noModel ? CODE_ONLY : config.decider.url });
const session = new Session();

function describe(o: Outcome): string {
  switch (o.decision) {
    case "act":
    case "confirm": {
      const slots = Object.entries(o.slots).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
      return `${o.decision.toUpperCase()} ${o.operation}${slots ? ` ${slots}` : ""}${o.decision === "confirm" ? '  (say "confirm")' : ""}`;
    }
    case "ask":
      if (o.parts) return `ASK one at a time: ${o.parts.map((p, i) => `${i + 1}) "${p}"`).join("  ")}`;
      return `ASK ${o.options.map((x) => `${x.operation} ${(x.p * 100).toFixed(0)}%`).join(" | ")}`;
    default:
      return o.decision.toUpperCase();
  }
}

try {
  for (const raw of positionals) {
    rec.event("utterance", { raw });
    const u = await understand(client, raw, { request: { isCommand } });
    const outcome = session.handle(u.outcome);
    rec.event("decision", {
      text: u.norm.text,
      fixes: u.norm.fixes,
      answers: u.decision
        ? Object.fromEntries(Object.entries(u.decision.answers).map(([k, a]) => [k, a.type === "choice" ? { choice: a.choice, p: a.probabilities[a.choice] } : a]))
        : {},
      modelMs: u.decision && !noModel ? Math.round(u.decision.latencyMs) : 0,
      codeMs: Number(u.codeMs.toFixed(2)),
    });
    rec.event("outcome", { ...outcome });
    const fixes = u.norm.fixes.length ? `   [${u.norm.fixes.join(", ")}]` : "";
    console.log(`"${raw}" → "${u.norm.text}"${fixes}`);
    const timing = u.decision && !noModel ? `model ${u.decision.latencyMs.toFixed(0)} ms + code ${u.codeMs.toFixed(1)} ms` : `code only, ${u.codeMs.toFixed(1)} ms`;
    console.log(`  ${describe(outcome)}   · ${outcome.reason} · ${timing}`);
  }
} catch (err) {
  rec.event("error", { message: String(err) });
  console.error(err instanceof SystemOneError ? `${err.code}: ${err.message}` : err);
  process.exit(1);
}
console.log(`\nrecorded: ${rec.dir}`);
