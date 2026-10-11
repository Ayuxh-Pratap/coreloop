/**
 * Rebuilds the pipeline map (docs/pipeline-map.html) from the real code, so it can't drift:
 *   - every file the map lists must exist, every code file must be on the map, and every file's stages must be boxes
 *     in the flowchart (fails otherwise)
 *   - line counts are read from disk
 *   - the example traces are re-recorded through the real actor on a simulated copy of the fixture desktop, so
 *     context (the app in front) and two-step commands show as they would live; nothing touches this machine
 *
 *   npm run map                       re-record traces (needs `npm run models:start`), rebuild the page
 *   npm run map -- --offline          reuse docs/pipeline-map/traces.json, rebuild the page
 *   npm run map -- --fragment <file>  also write the page without its <html> wrapper (for publishing elsewhere)
 *
 * The page itself (layout, charts, numbers, file descriptions) lives in docs/pipeline-map/template.html. The commands
 * in the trace picker, each with the simulated world it runs in (src/sim/world.ts), are docs/pipeline-map/inputs.json:
 * change them there, then run `npm run map`.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SystemOneClient } from "../backends/systemone.ts";
import { config } from "../config.ts";
import { evalProfileDir, useProfileFiles } from "../host/profile-files.ts";
import { understand } from "../core/pipeline.ts";
import { scrub } from "../demo/export.ts";
import { Actor } from "../live/actor.ts";
import { fixtureApps, fixtureWindows, loadPages } from "../sim/fixture.ts";
import { SIM_SKILLS } from "../sim/skills.ts";
import { buildWorld, type WorldSpec } from "../sim/world.ts";
import { SkillSet } from "../skills/skillset.ts";
import { Surfaces } from "../surface/router.ts";

// the evals' fixture profile (eval/profile/), so the map's traces are the same on every machine
useProfileFiles(evalProfileDir());


const DIR = join("docs", "pipeline-map");
const TEMPLATE = join(DIR, "template.html");
const TRACES = join(DIR, "traces.json");
const INPUTS = join(DIR, "inputs.json");

/** One command in the trace picker, and the world it runs in. */
export interface TraceInput {
  said: string;
  world: WorldSpec;
}

export function traceInputs(): TraceInput[] {
  return JSON.parse(readFileSync(INPUTS, "utf8")) as TraceInput[];
}
const OUT = join("docs", "pipeline-map.html");
/** Folders whose files belong on the map. */
const MAPPED_ROOTS = ["src", "scripts", "eval", "test", "profile"];
/** Private or generated files that never go on the map (personal voice recordings are gitignored). */
const NOT_MAPPED = ["eval/audio/recordings/"];

const { values } = parseArgs({ options: { offline: { type: "boolean", default: false }, fragment: { type: "string" } } });

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p.replace(/\\/g, "/")];
  });
}

async function recordTraces(): Promise<unknown[]> {
  const warm = new SkillSet(SIM_SKILLS);
  const fx = { apps: fixtureApps(), pages: loadPages(), windows: fixtureWindows() };
  const apps = fx.apps;
  const client = new SystemOneClient({ baseUrl: config.decider.url, timeoutMs: config.decider.timeoutMs });
  if (!(await client.health()).ok) {
    throw new Error(`model server not reachable at ${config.decider.url}. Start it (npm run models:start) or use --offline`);
  }
  for (let i = 0; i < 3; i++) await understand(client, "warm up", { ctx: { apps, skills: warm } });
  const traces: unknown[] = [];
  for (const input of traceInputs()) {
    const raw = input.said;
    const page = input.world.browser?.page;
    // a page and an app in front: both surfaces, the browser inside Brave
    const front = page ? (typeof input.world.desktop === "object" ? input.world.desktop.foreground : undefined) : input.world.front;
    const sim = buildWorld(input.world, fx).surface;
    const actor = new Actor({ client, surface: sim });
    const skills = actor.skills;
    const r = await actor.handle(raw);
    // which surface carried it out, when there are several
    const via = (r.plan?.data as { via?: unknown } | undefined)?.via;
    const ranOn = sim instanceof Surfaces && typeof via === "number" ? sim.surfaces[via]!.name : undefined;
    const u = r.understood;
    const model = u.decision
      ? {
          questions: Object.keys(u.decision.answers),
          tokens: u.decision.inputTokens,
          ms: Math.round(u.decision.latencyMs),
          answers: Object.fromEntries(
            Object.entries(u.decision.answers).flatMap(([k, a]) =>
              a.type === "choice" ? [[k, a.ranked.slice(0, 3).map((r) => [r.option, Math.round(r.p * 1000) / 10])]] : [],
            ),
          ),
        }
      : null;
    // the plan as people read it: a summary and its steps in words (what the simulation will play back)
    const plan = r.plan ? { summary: r.plan.summary, steps: r.plan.detail, shows: r.plan.shows ?? null } : r.planError ? { error: r.planError } : null;
    const op = "operation" in r.outcome ? r.outcome.operation : "";
    traces.push({
      raw,
      ...(page ? { surface: front ? "desktop + browser" : "browser", page } : {}),
      ...(front && page ? { front } : {}),
      ...(ranOn ? { ranOn } : {}),
      text: u.norm.text,
      fixes: u.norm.fixes,
      codeOnly: !u.decision,
      // the target matters when it was named or its app has a skill (VS Code in front changes nothing yet)
      target: u.scope.target && (u.scope.target.via === "named" || skills.forApp(u.scope.target.app)) ? { ...u.scope.target, named: u.scope.named, command: u.scope.text } : null,
      skill: Boolean(skills.action(op)) || Boolean(model?.answers.operation?.some(([o]) => String(o).includes("."))),
      model,
      outcome: r.outcome,
      plan,
    });
  }
  return scrub(traces) as unknown[];
}

const template = readFileSync(TEMPLATE, "utf8");

// 1. The file list on the map vs the files in the repo.
const mapped = [...template.matchAll(/^\s*\["([^"]+)", "(?:entry|audio|host|live|core|skills|model|surface|ctx|measure)"/gm)].map((m) => m[1]!);
const missing = mapped.filter((f) => !existsSync(f));
if (missing.length) {
  console.error(`the map lists files that don't exist (update ${TEMPLATE}):\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
const unmapped = MAPPED_ROOTS.flatMap(walk).filter((f) => !mapped.includes(f) && !NOT_MAPPED.some((p) => f.startsWith(p)));
if (unmapped.length) {
  console.error(`not on the map yet (add a row to FILES in ${TEMPLATE}):\n  ${unmapped.join("\n  ")}`);
  process.exit(1);
}

// 1b. The flowchart and the files agree: every stage a file names is a box in the flowchart, and every
//     box has files behind it. A new stage in the code can't be left off the picture.
const stages = JSON.parse(/const STAGES = (\{.*?\});/.exec(template)?.[1] ?? "{}") as Record<string, string>;
const drawn = new Set([...template.matchAll(/<g class="node [a-z]+" id="(n-[a-z]+)"/g)].map((m) => m[1]!));
const rows = [...template.matchAll(/^\s*\["([^"]+)", "(?:entry|audio|host|live|core|skills|model|surface|ctx|measure)", "([^"]+)"/gm)].map((m) => ({ file: m[1]!, stages: m[2]!.split(" · ") }));
const used = new Set<string>();
const problems: string[] = [];
for (const r of rows) {
  for (const s of r.stages) {
    const box = stages[s];
    if (!box) problems.push(`${r.file}: stage "${s}" has no box (add it to STAGES)`);
    else if (box !== "*") used.add(box);
  }
}
for (const [s, box] of Object.entries(stages)) if (box !== "*" && !drawn.has(box)) problems.push(`stage "${s}" points at "${box}", which isn't drawn`);
for (const box of drawn) if (!used.has(box)) problems.push(`the box "${box}" has no file behind it`);
if (problems.length) {
  console.error(`the flowchart and the files disagree (${TEMPLATE}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

// 2. Real line counts.
const lines = Object.fromEntries(mapped.map((f) => [f, readFileSync(f, "utf8").split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l !== "").length]));
const total = Object.values(lines).reduce((a, b) => a + b, 0);

// 3. Traces: re-recorded, or the saved ones.
let traces: unknown[];
if (values.offline) {
  traces = JSON.parse(readFileSync(TRACES, "utf8")) as unknown[];
  console.log(`using saved traces (${traces.length})`);
} else {
  traces = await recordTraces();
  writeFileSync(TRACES, JSON.stringify(traces, null, 2) + "\n");
  console.log(`recorded ${traces.length} traces → ${TRACES}`);
}

const fragment = template
  .replace("__TRACES__", () => JSON.stringify(traces))
  .replace("__LINES__", () => JSON.stringify(lines))
  .replace("__FILECOUNT__", String(mapped.length))
  .replace("__TOTALLINES__", total.toLocaleString("en-US"));
if (/__[A-Z]+__/.test(fragment)) throw new Error("a placeholder in the template was not filled");

writeFileSync(
  OUT,
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`,
);
console.log(`wrote ${OUT}: ${mapped.length} files, ${total} lines, ${traces.length} traces`);
if (values.fragment) {
  writeFileSync(values.fragment, fragment);
  console.log(`wrote ${values.fragment} (no <html> wrapper)`);
}
