/**
 * Eval runner: runs every case of a suite through the real pipeline (normalise → model → policy) WITHOUT
 * acting, and reports two scores:
 *   pipeline  the final outcome: decision (act/confirm/ask/wait/ignore), operation, and every resolved slot
 *   model     the raw model answers per question (comparable with the M2 baseline)
 *
 *   npm run eval                       desktop suite
 *   npm run eval -- --with-is-command  also ask the separate "is this a command?" gate (off by default since M3)
 *   npm run eval -- --compare          with and without it, side by side
 *   npm run eval -- --packed           independent:false (rejected in M2, kept for re-checks)
 *   npm run eval -- --only close       cases whose id starts with, or tag equals, "close"
 *   npm run eval -- --verbose          every case, not only failures
 *   npm run eval -- daily              conversations (eval/daily.json): each turn played through the real actor on the
 *                                      simulated desktop surface, scored right / asked / wrong
 *   npm run eval -- browser            the browser prototype's 34 cases on the simulated browser
 *   npm run eval -- daily --over-ws    the same, with every simulated surface connected over the loopback WebSocket
 *   npm run eval -- daily --no-model   no-model mode: code decides what it can, the rest is asked
 *
 * Each run is saved to runs/eval/<time>-<suite>-<variant>.json (gitignored).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SystemOneClient, SystemOneError, type Decider } from "../backends/systemone.ts";
import { CODE_ONLY, CodeOnlyDecider } from "../backends/codeonly.ts";
import { config } from "../config.ts";
import { evalProfileDir, useProfileFiles } from "../host/profile-files.ts";
import { EMPTY_PROFILE, useProfile } from "../profile/profile.ts";
import { understand } from "../core/pipeline.ts";
import type { SlotContext } from "../core/slots.ts";
import { buildRequest, type RequestOptions } from "../core/questions.ts";
import { judgeTurn, parseConversations, tally, worldOf, type TurnResult } from "../eval/conversation.ts";
import { fixtureApps, fixtureDesktop, fixtureWindows, loadPages } from "../sim/fixture.ts";
import { buildWorld, surfaceOf, type Fixtures } from "../sim/world.ts";
import { SIM_SKILLS } from "../sim/skills.ts";
import { SkillSet } from "../skills/skillset.ts";
import { PlanError, type Surface } from "../surface/contract.ts";
import { serveSurface, type SurfaceConnection } from "../surface/client.ts";
import { CoreServer } from "../host/server.ts";
import { Actor } from "../live/actor.ts";
import { parseCases, percentile, scoreCase, scorePipeline, type CaseResult, type EvalCase, type FieldResult, type PipelineResult } from "../eval/score.ts";

// the evals' fixture profile (eval/profile/), or the one named by COLOOP_PROFILE_DIR (the learning loop's gate)
const profile = useProfileFiles(evalProfileDir());

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    packed: { type: "boolean", default: false },
    "with-is-command": { type: "boolean", default: false },
    compare: { type: "boolean", default: false },
    only: { type: "string" },
    verbose: { type: "boolean", default: false },
    "over-ws": { type: "boolean", default: false },
    "no-model": { type: "boolean", default: false },
  },
});

const suite = positionals[0] ?? "desktop";
const conversational = existsSync(join("eval", `${suite}.json`));
const file = join("eval", conversational ? `${suite}.json` : `${suite}.jsonl`);
let cases: EvalCase[] = conversational ? [] : parseCases(readFileSync(file, "utf8"), file);
if (values.only) cases = cases.filter((c) => c.id.startsWith(values.only!) || (c.tags ?? []).includes(values.only!));
if (!conversational && cases.length === 0) {
  console.error(`no cases in ${file}${values.only ? ` matching "${values.only}"` : ""}`);
  process.exit(2);
}

// The fixture desktop (eval/apps.json from a real Start menu, eval/windows.json) as a simulated surface, with the
// example skills, so results don't depend on this machine.
const ctx: SlotContext = { apps: fixtureApps(), skills: new SkillSet(SIM_SKILLS) };
const desktop = fixtureDesktop();

const noModel = values["no-model"];
const http = new SystemOneClient({ baseUrl: config.decider.url, timeoutMs: config.decider.timeoutMs });
const health = noModel ? { ok: true, model: CODE_ONLY } : await http.health();
const client: Decider = noModel ? new CodeOnlyDecider() : http;
if (!health.ok) {
  console.error(`model server not reachable at ${config.decider.url}. Start it: npm run models:start`);
  process.exit(1);
}

interface Variant {
  name: string;
  opts: RequestOptions;
}
const independent = values.packed ? false : undefined;
const variants: Variant[] = values.compare
  ? [
      { name: "with-is-command", opts: { independent, isCommand: true } },
      { name: "no-is-command", opts: { independent, isCommand: false } },
    ]
  : [{ name: noModel ? "no-model" : values["with-is-command"] ? "with-is-command" : "no-is-command", opts: { independent, isCommand: values["with-is-command"] } }];

interface RunResult {
  variant: string;
  pipeline: PipelineResult[];
  model: CaseResult[];
  latencies: number[];
  /** Cases code decided without calling the model. */
  codeOnly: string[];
}

async function run(v: Variant): Promise<RunResult> {
  for (let i = 0; i < 2; i++) await understand(client, "warm up", { request: v.opts, ctx }); // the live loop is always warm
  const pipeline: PipelineResult[] = [];
  const model: CaseResult[] = [];
  const latencies: number[] = [];
  const codeOnly: string[] = [];
  for (const c of cases) {
    const u = await understand(client, c.said, { request: v.opts, ctx });
    latencies.push(u.totalMs);
    const scored = scorePipeline(c, u.outcome);
    // every act/confirm must also turn into a plan on the fixture desktop (dry run: nothing executes)
    if (u.outcome.decision === "act" || u.outcome.decision === "confirm") {
      try {
        desktop.plan(u.outcome);
      } catch (err) {
        if (!(err instanceof PlanError)) throw err;
        scored.fields.push({ field: "plan", expected: "ok", got: err.message, ok: false, p: 1 });
        scored.pass = false;
      }
    }
    pipeline.push(scored);
    if (!u.decision) codeOnly.push(c.id);
    // model accuracy is scored on every case, so it stays comparable with M2; this extra call is not timed
    if (noModel) continue;
    const answers = u.decision?.answers ?? (await client.decide(buildRequest(u.norm.text, { ...v.opts, operations: ctx.skills!.modelOptions() }))).answers;
    model.push(scoreCase(c, answers));
  }
  return { variant: v.name, pipeline, model, latencies, codeOnly };
}

const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(1)}%`;

function fieldTable(fields: FieldResult[]): string[] {
  const by = new Map<string, { ok: number; n: number }>();
  for (const f of fields) {
    const s = by.get(f.field) ?? { ok: 0, n: 0 };
    s.n++;
    if (f.ok) s.ok++;
    by.set(f.field, s);
  }
  return [...by].map(([field, s]) => `${field} ${s.ok}/${s.n}`);
}

function report(r: RunResult): void {
  const passed = r.pipeline.filter((x) => x.pass).length;
  const modelPassed = r.model.filter((x) => x.pass).length;
  const sorted = [...r.latencies].sort((a, b) => a - b);
  const decisions = new Map<string, number>();
  for (const x of r.pipeline) decisions.set(x.outcome.decision, (decisions.get(x.outcome.decision) ?? 0) + 1);

  console.log(`\n=== ${suite} · ${r.variant}${values.packed ? " · packed" : ""} · ${health.model} ===`);
  console.log(`PIPELINE pass ${passed}/${r.pipeline.length} (${pct(passed, r.pipeline.length)})   ${fieldTable(r.pipeline.flatMap((x) => x.fields)).join(" · ")}`);
  console.log(`         outcomes: ${[...decisions].map(([d, n]) => `${d} ${n}`).join(" · ")}`);
  const unsafe = r.pipeline.filter((x) => x.unsafe);
  console.log(`         destructive acted on without confirm: ${unsafe.length}${unsafe.length ? `  [${unsafe.map((x) => x.id).join(", ")}]` : ""}`);
  const pending = [...new Set(r.pipeline.flatMap((x) => x.pending))];
  if (pending.length) console.log(`         not evaluated yet: ${pending.join(", ")}`);
  if (r.model.length) console.log(`MODEL    pass ${modelPassed}/${r.model.length} (${pct(modelPassed, r.model.length)})   ${fieldTable(r.model.flatMap((x) => x.fields)).join(" · ")}`);
  const modelPath = r.latencies.filter((_, i) => !r.codeOnly.includes(r.pipeline[i]!.id)).sort((a, b) => a - b);
  console.log(`latency  all cases p50 ${percentile(sorted, 0.5).toFixed(0)} ms · p95 ${percentile(sorted, 0.95).toFixed(0)} ms   |   cases that call the model (${modelPath.length}): p50 ${percentile(modelPath, 0.5).toFixed(0)} ms · p95 ${percentile(modelPath, 0.95).toFixed(0)} ms`);
  console.log(`         decided by code alone: ${r.codeOnly.length}/${r.pipeline.length}`);

  const groups = new Map<string, string[]>();
  for (const x of r.pipeline) {
    for (const f of x.fields.filter((y) => !y.ok)) {
      const key = `${f.field}: ${f.expected} → ${f.got}`;
      groups.set(key, [...(groups.get(key) ?? []), `${x.id} "${x.said}"  · ${x.outcome.reason}`]);
    }
  }
  if (groups.size) {
    console.log("pipeline failures:");
    for (const [key, items] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${key}  ×${items.length}`);
      for (const it of items) console.log(`      ${it}`);
    }
  }
  if (values.verbose) {
    console.log("all cases:");
    for (const x of r.pipeline) console.log(`  ${x.pass ? "✔" : "✖"} ${x.id.padEnd(11)} ${x.fields.map((f) => `${f.field}=${f.got}`).join(" ")}`);
  }

  const dir = join("runs", "eval");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(dir, `${stamp}-${suite}-${r.variant}.json`), JSON.stringify({ suite, modelName: health.model, ...r }, null, 2));
}

/** Plays every conversation through a fresh actor on its own simulated desktop. */
async function runConversations(): Promise<void> {
  let convs = parseConversations(readFileSync(file, "utf8"), file);
  if (values.only) convs = convs.filter((c) => c.id.startsWith(values.only!));
  for (let i = 0; i < 2; i++) await understand(client, "warm up", { ctx }); // the live loop is always warm
  const results: TurnResult[] = [];
  const fx: Fixtures = { apps: fixtureApps(), pages: convs.some((c) => c.surface === "browser" || c.browser) ? loadPages() : {}, windows: fixtureWindows() };
  // --over-ws: every simulated surface connects to a real core server over the loopback WebSocket
  const server = values["over-ws"] ? await CoreServer.start({ port: 0 }) : undefined;
  const turnMs: number[] = [];
  for (const c of convs) {
    const world = buildWorld(worldOf(c), fx);
    useProfile(c.profile === false ? EMPTY_PROFILE : profile);
    const conns: SurfaceConnection[] = [];
    if (server) {
      for (const l of world.parts) conns.push(await serveSurface(l.surface, { url: `ws://127.0.0.1:${server.port}`, token: server.token, ...(l.inside ? { inside: l.inside } : {}) }));
      await server.waitFor(world.parts.length);
    }
    const sim: Surface = server ? server.surface() : world.surface;
    const actor = new Actor({ client: c.model === false ? new CodeOnlyDecider() : client, surface: sim });
    for (const [i, turn] of c.turns.entries()) {
      const t0 = performance.now();
      const r = await actor.handle(turn.said);
      turnMs.push(performance.now() - t0);
      const u = r.understood;
      results.push({ conversation: c.id, index: i + 1, said: turn.said, ...judgeTurn(turn, r, surfaceOf(sim, r.plan?.data)), setup: turn.setup, reason: r.outcome.reason, ms: u.totalMs, codeOnly: !u.decision });
      for (const l of world.parts) (l.surface as Surface).afterTurn?.();
    }
    for (const conn of conns) {
      conn.close();
      await conn.closed;
    }
  }
  await server?.close();
  useProfile(profile);

  // setup turns only lead up to the turn being scored: shown when they go wrong, not counted
  const scored = results.filter((r) => !r.setup);
  const t = tally(scored);
  const sorted = scored.map((r) => r.ms).sort((a, b) => a - b);
  const setupNote = scored.length < results.length ? ` (+${results.length - scored.length} setup)` : "";
  console.log(`\n=== ${suite} · ${convs.length} conversation(s), ${t.n} turns${setupNote} · ${health.model} ===`);
  console.log(`WRONG ${t.wrong}/${t.n} (${pct(t.wrong, t.n)})   right ${t.right} (${pct(t.right, t.n)}) · asked ${t.asked} (${pct(t.asked, t.n)})`);
  console.log(`latency p50 ${percentile(sorted, 0.5).toFixed(0)} ms · p95 ${percentile(sorted, 0.95).toFixed(0)} ms · decided by code alone ${scored.filter((r) => r.codeOnly).length}/${t.n}`);
  const whole = [...turnMs].sort((a, b) => a - b);
  console.log(`whole turn (view, decide, plan, run${values["over-ws"] ? ", over the WebSocket" : ""}) p50 ${percentile(whole, 0.5).toFixed(1)} ms · p95 ${percentile(whole, 0.95).toFixed(1)} ms`);
  const mark = { right: "✔", asked: "·", wrong: "✖" } as const;
  for (const r of results) {
    if (r.verdict === "right" && !values.verbose) continue;
    const off = r.fields.filter((f) => !f.ok).map((f) => `${f.field} ${f.expected}≠${f.got}`).join(", ");
    console.log(`  ${mark[r.verdict]}${r.setup ? " setup" : ""} ${r.conversation}#${String(r.index).padEnd(3)} "${r.said}" → ${r.got}${off ? `   [${off}]` : ""}${values.verbose ? `  · ${r.reason}` : ""}`);
  }

  const dir = join("runs", "eval");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(dir, `${stamp}-${suite}${noModel ? "-no-model" : ""}.json`), JSON.stringify({ suite, modelName: health.model, tally: t, results }, null, 2));
}

try {
  if (conversational) await runConversations();
  else for (const v of variants) report(await run(v));
} catch (err) {
  console.error(err instanceof SystemOneError ? `${err.code}: ${err.message}` : err);
  process.exit(1);
}
