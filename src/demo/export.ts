/**
 * The demo export: plays every scenario through the real engine on the simulated surfaces, with the local
 * model and without it, under a trace, and writes what happened as versioned JSON (src/demo/schema.ts) for the site
 * to replay. Every scenario is recorded twice and the two must agree (timings aside), so the site shows what the
 * engine does, not one lucky run.
 *
 * The scenarios: the book's examples and the playground's presets (eval/demo.json), every eval conversation, the
 * desktop eval cases, and the pipeline map's traces. Host tooling: it reads files and runs the model's client; the
 * engine itself stays as it is.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodeOnlyDecider, CODE_ONLY } from "../backends/codeonly.ts";
import type { Answer, Decider } from "../backends/systemone.ts";
import { understand } from "../core/pipeline.ts";
import { traced } from "../core/trace.ts";
import { judgeTurn, parseConversations, worldOf, type Conversation } from "../eval/conversation.ts";
import { parseCases, percentile, scorePipeline } from "../eval/score.ts";
import { Actor, type ActResult } from "../live/actor.ts";
import { EMPTY_PROFILE, useProfile, type Profile } from "../profile/profile.ts";
import { fixtureApps, fixtureWindows, loadPages } from "../sim/fixture.ts";
import { SIM_SKILLS } from "../sim/skills.ts";
import { buildWorld, surfaceOf, type Fixtures, type WorldSpec } from "../sim/world.ts";
import { SkillSet } from "../skills/skillset.ts";
import type { Surface, SurfaceView } from "../surface/contract.ts";
import { PROTOCOL_VERSION } from "../surface/protocol.ts";
import {
  differences,
  RUNS,
  SCHEMA_VERSION,
  validateExport,
  type CaseTally,
  type CodeFile,
  type ConversationTally,
  type EvalsFile,
  type Manifest,
  type MapFile,
  type Marker,
  type RunName,
  type RunRecord,
  type Scenario,
  type ScenariosFile,
  type TurnRecord,
  type TurnsFile,
} from "./schema.ts";

/** The eval sets played as tours, in order. The personal set is mine and never exported. */
export const TOUR_SETS = ["daily", "daily-holdout", "workflow", "workflow-holdout", "browser", "nested", "nested-holdout"];
/** The desktop eval cases, played one turn each on the fixture desktop. */
export const CASE_SETS = ["desktop", "desktop-holdout"];

/** Replaces the user's home folder anywhere in recorded data, so it is safe to publish. */
export function scrub<T>(value: T): T {
  const home = process.env.USERPROFILE;
  const json = JSON.stringify(value);
  const cleaned = home ? json.split(JSON.stringify(home).slice(1, -1)).join("%USERPROFILE%") : json;
  return JSON.parse(cleaned.replace(/C:\\\\Users\\\\[^"\\]+/gi, "%USERPROFILE%")) as T;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p.replace(/\\/g, "/")];
  });
}

/** Every trace marker in src/ (a call to step or ruled with a stage and an id), at the line of its id; comments don't count. */
export function codeData(root = "src"): CodeFile {
  const markers: Record<string, Marker> = {};
  const files: Record<string, string> = {};
  for (const file of walk(root).filter((f) => f.endsWith(".ts") && f !== "src/core/trace.ts")) {
    const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    for (const m of text.matchAll(/\b(?:step|ruled)\(\s*"([^"]+)",\s*"([^"]+)"/g)) {
      const at = m.index + m[0].lastIndexOf(`"${m[2]}"`);
      const before = text.slice(text.lastIndexOf("\n", m.index) + 1, m.index);
      if (/^\s*(\/?\*|\/\/)/.test(before)) continue;
      markers[m[2]!] ??= { stage: m[1]!, file, line: text.slice(0, at).split("\n").length };
      files[file] = text;
    }
  }
  return { schema: SCHEMA_VERSION, markers, files };
}

const unescape = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
const num = (s: string | undefined) => Number(s ?? 0);

/** The pipeline map's data, from its template (docs/pipeline-map/template.html). */
export function mapData(template: string): MapFile {
  const stages = JSON.parse(/const STAGES = (\{.*?\});/.exec(template)?.[1] ?? "{}") as Record<string, string>;
  const start = template.indexOf("const FILES = [");
  const body = template.slice(start, template.indexOf("\n];", start)).split("\n").slice(1);
  const files = body
    .map((l) => l.trim().replace(/,$/, ""))
    .filter(Boolean)
    .map((l) => {
      const [file, group, st, what] = JSON.parse(l) as [string, string, string, string];
      const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter((x, i, a) => i < a.length - 1 || x !== "").length : 0;
      return { file, group, stages: st.split(" · "), what, lines };
    });
  const svg = /<svg viewBox="([^"]+)" role="img" aria-label="Flowchart[\s\S]*?<\/svg>/.exec(template);
  if (!svg) throw new Error("the map's flowchart isn't in the template");
  const nodes = [...svg[0].matchAll(/<g class="node ([a-z]+)" id="(n-[a-z]+)"><rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*\/>(.*?)<\/g>/g)].map((m) => {
    const texts = [...m[7]!.matchAll(/<text class="([a-z]+)"[^>]*>(.*?)<\/text>/g)];
    return {
      id: m[2]!,
      kind: m[1]!,
      x: num(m[3]),
      y: num(m[4]),
      width: num(m[5]),
      height: num(m[6]),
      title: unescape(texts.find((t) => t[1] === "t")?.[2] ?? ""),
      sub: texts.filter((t) => t[1] === "s").map((t) => unescape(t[2]!)),
    };
  });
  const edges = [...svg[0].matchAll(/<path id="(e-[a-z0-9-]+)" class="([^"]+)" d="([^"]+)"/g)].map((m) => ({ id: m[1]!, kind: m[2]!, d: m[3]! }));
  const labels = [...svg[0].matchAll(/<g class="elg" id="(l-[a-z0-9-]+)">(.*?)<\/g>/g)].map((m) => ({
    id: m[1]!,
    lines: [...m[2]!.matchAll(/<text class="el" x="([\d.]+)" y="([\d.]+)"( text-anchor="([a-z]+)")?>(.*?)<\/text>/g)].map((t) => ({ x: num(t[1]), y: num(t[2]), text: unescape(t[5]!), anchor: t[4] ?? null })),
  }));
  return { schema: SCHEMA_VERSION, stages, files, flowchart: { viewBox: svg[1]!, nodes, edges, labels } };
}

/** Every scenario, from the catalogue, the eval sets and the map's inputs. */
export function scenarios(evalDir = "eval"): Scenario[] {
  const out: Scenario[] = [];
  const fromConversation = (set: string, c: Conversation, kind: Scenario["kind"]): Scenario => ({
    id: `${set}.${c.id}`,
    kind,
    set,
    ...(c.title ? { title: c.title } : {}),
    ...(c.note ? { note: c.note } : {}),
    ...(c.tags ? { tags: c.tags } : {}),
    world: worldOf(c),
    turns: c.turns.map((t) => ({ said: t.said, ...(t.setup ? { setup: true } : {}), expect: t.expect })),
    runs: c.model === false ? ["no-model"] : [...RUNS],
  });
  const read = (set: string) => parseConversations(readFileSync(join(evalDir, `${set}.json`), "utf8"), `${set}.json`);
  for (const c of read("demo")) out.push(fromConversation("demo", c, c.tags?.includes("book") ? "book" : "preset"));
  for (const set of TOUR_SETS) for (const c of read(set)) out.push(fromConversation(set, c, "tour"));
  for (const set of CASE_SETS) {
    for (const c of parseCases(readFileSync(join(evalDir, `${set}.jsonl`), "utf8"), `${set}.jsonl`)) {
      out.push({ id: `${set}.${c.id}`, kind: "case", set, ...(c.tags ? { tags: c.tags } : {}), world: { desktop: "fixture" }, turns: [{ said: c.said, expect: c.expect }], runs: [...RUNS] });
    }
  }
  const inputs = JSON.parse(readFileSync(join("docs", "pipeline-map", "inputs.json"), "utf8")) as { said: string; world: WorldSpec }[];
  inputs.forEach((x, i) => out.push({ id: `map.${String(i + 1).padStart(2, "0")}`, kind: "map", set: "map", title: x.said, world: x.world, turns: [{ said: x.said }], runs: [...RUNS] }));
  return out;
}

/** The fields of `view` that differ from `before` (all of them for the first view). */
function delta(view: SurfaceView, before: SurfaceView | undefined): Partial<SurfaceView> {
  if (!before) return view;
  const out: Record<string, unknown> = {};
  for (const k of ["places", "path", "open", "items"] as const) if (JSON.stringify(view[k]) !== JSON.stringify(before[k])) out[k] = view[k];
  return out as Partial<SurfaceView>;
}

const round = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === "number" && !Number.isInteger(x) ? Math.round(x * 10000) / 10000 : x)));

/**
 * One turn's verdict: the conversation eval's, or (for a desktop case) the pipeline eval's, as right / asked / wrong.
 * A case is scored on the outcome before the session, as `npm run eval` scores it ("confirm" with nothing waiting is
 * the confirm operation there; the session then ignores it).
 */
function verdictOf(s: Scenario, i: number, r: ActResult, surface: Surface): TurnRecord["verdict"] {
  const expect = s.turns[i]!.expect;
  if (!expect) return null;
  if (s.kind !== "case") return judgeTurn({ said: s.turns[i]!.said, expect }, r, surfaceOf(surface, r.plan?.data));
  const outcome = r.understood.outcome;
  const scored = scorePipeline({ id: s.id, said: s.turns[i]!.said, expect, ...(s.tags ? { tags: s.tags } : {}) }, outcome);
  const acts = outcome.decision === "act" || outcome.decision === "confirm";
  return { verdict: scored.pass ? "right" : acts ? "wrong" : "asked", fields: scored.fields, got: "operation" in outcome ? `${outcome.decision} ${outcome.operation}` : outcome.decision };
}

/** Plays one scenario in a fresh world, every turn under a trace. */
export async function recordRun(s: Scenario, decider: Decider, fx: Fixtures, profile: Profile): Promise<RunRecord> {
  useProfile(s.world.profile === false ? EMPTY_PROFILE : profile);
  try {
    const world = buildWorld(s.world, fx);
    const actor = new Actor({ client: decider, surface: world.surface });
    let last = await world.surface.view();
    const views: Partial<SurfaceView>[] = [delta(last, undefined)];
    const turns: TurnRecord[] = [];
    for (const [i, turn] of s.turns.entries()) {
      const t0 = performance.now();
      const { value: r, steps } = await traced(() => actor.handle(turn.said));
      const ms = performance.now() - t0;
      for (const p of world.parts) (p.surface as Surface).afterTurn?.();
      const u = r.understood;
      const o = r.outcome;
      turns.push({
        said: turn.said,
        ...(turn.setup ? { setup: true } : {}),
        steps,
        outcome: o,
        plan: r.plan ? { summary: r.plan.summary, steps: [...r.plan.detail], shows: r.plan.shows ?? null } : r.planError ? { error: r.planError } : null,
        pending: r.pending?.summary ?? null,
        ran: r.ran,
        via: r.plan ? (surfaceOf(world.surface, r.plan.data) ?? null) : null,
        repair: r.repair ?? null,
        model: u.decision && u.decision.model !== CODE_ONLY ? { model: u.decision.model, tokens: u.decision.inputTokens, ms: Math.round(u.decision.latencyMs), answers: round(u.decision.answers) as Record<string, Answer> } : null,
        reply: o.decision === "ask" ? (o.hint ?? null) : r.notes?.length ? r.notes.join(" ") : null,
        verdict: verdictOf(s, i, r, world.surface),
        ms: Math.round(ms * 100) / 100,
        codeOnly: !u.decision,
        decideMs: Math.round(u.totalMs * 100) / 100,
      });
      const now = await world.surface.view();
      views.push(delta(now, last));
      last = now;
    }
    return scrub({ views, turns });
  } finally {
    useProfile(profile);
  }
}

function tallyOf(list: { s: Scenario; r: RunRecord }[], kind: "conversation" | "case"): ConversationTally | CaseTally {
  const scored = list.flatMap(({ r }) => r.turns.filter((t) => !t.setup && t.verdict));
  const ms = scored.map((t) => t.decideMs).sort((a, b) => a - b);
  const common = { codeOnly: scored.filter((t) => t.codeOnly).length, p50: Math.round(percentile(ms, 0.5)), p95: Math.round(percentile(ms, 0.95)) };
  if (kind === "case") {
    return { cases: scored.length, pass: scored.filter((t) => t.verdict!.verdict === "right").length, unsafe: list.filter(({ s, r }) => s.tags?.includes("destructive") && r.turns[0]!.verdict?.fields[0]?.got === "act").length, ...common };
  }
  const n = (v: string) => scored.filter((t) => t.verdict!.verdict === v).length;
  return { conversations: list.length, turns: scored.length, right: n("right"), asked: n("asked"), wrong: n("wrong"), ...common };
}

export interface ExportOptions {
  out: string;
  /** The model's client for the "model" runs; none: only the no-model runs are recorded. */
  model?: { decider: Decider; name: string };
  /** Only scenarios whose id starts with one of these. */
  only?: string[];
  /** Record once, without the second run that checks every scenario reproduces. */
  once?: boolean;
  profile: Profile;
  log?: (line: string) => void;
}

export interface ExportResult {
  manifest: Manifest;
  problems: string[];
  /** Scenario runs whose second recording differed from the first. */
  drift: string[];
  /** Markers in the source no recorded step passed through. */
  unvisited: string[];
}

export async function exportDemo(o: ExportOptions): Promise<ExportResult> {
  const log = o.log ?? (() => {});
  const fx: Fixtures = { apps: fixtureApps(), pages: loadPages(), windows: fixtureWindows() };
  const runs: RunName[] = o.model ? [...RUNS] : ["no-model"];
  let all = scenarios().map((s) => ({ ...s, runs: s.runs.filter((r) => runs.includes(r)) })).filter((s) => s.runs.length);
  if (o.only?.length) all = all.filter((s) => o.only!.some((p) => s.id.startsWith(p)));
  const code = codeData();
  const map = mapData(readFileSync(join("docs", "pipeline-map", "template.html"), "utf8"));

  const deciders: Record<RunName, Decider | undefined> = { model: o.model?.decider, "no-model": new CodeOnlyDecider() };
  if (o.model) {
    const warm = { apps: fx.apps, skills: new SkillSet(SIM_SKILLS) };
    for (let i = 0; i < 3; i++) await understand(o.model.decider, "warm up", { ctx: warm }); // the live loop is always warm
  }

  const recorded = new Map<string, Partial<Record<RunName, RunRecord>>>();
  const drift: string[] = [];
  for (const run of runs) {
    let n = 0;
    for (const s of all.filter((x) => x.runs.includes(run))) {
      const first = await recordRun(s, deciders[run]!, fx, o.profile);
      if (!o.once) {
        const diff = differences(first, await recordRun(s, deciders[run]!, fx, o.profile));
        if (diff.length) drift.push(`${s.id} (${run}): ${diff.slice(0, 3).join("; ")}`);
      }
      recorded.set(s.id, { ...recorded.get(s.id), [run]: first });
      if (++n % 50 === 0) log(`  ${run}: ${n} scenarios`);
    }
    log(`${run}: ${n} scenarios recorded${o.once ? "" : " twice"}`);
  }

  // the export folder: stale turn files from an earlier export are removed, nothing else is touched
  const turnsDir = join(o.out, "turns");
  mkdirSync(turnsDir, { recursive: true });
  const names = new Set(all.map((s) => `${s.id}.json`));
  for (const f of readdirSync(turnsDir)) if (f.endsWith(".json") && !names.has(f)) rmSync(join(turnsDir, f));
  const write = (file: string, data: unknown) => writeFileSync(join(o.out, file), JSON.stringify(data) + "\n");
  let turnCount = 0;
  for (const s of all) {
    const file: TurnsFile = { schema: SCHEMA_VERSION, id: s.id, runs: recorded.get(s.id)! };
    for (const r of Object.values(file.runs)) turnCount += r.turns.length;
    write(join("turns", `${s.id}.json`), file);
  }

  const evals: EvalsFile = { schema: SCHEMA_VERSION, model: o.model?.name ?? CODE_ONLY, sets: [] };
  for (const set of ["demo", ...TOUR_SETS, ...CASE_SETS]) {
    const of = all.filter((s) => s.set === set);
    if (!of.length) continue;
    const kind = CASE_SETS.includes(set) ? "case" : "conversation";
    const entry: EvalsFile["sets"][number] = { set, kind, runs: {} };
    for (const run of runs) {
      const list = of.filter((s) => s.runs.includes(run)).map((s) => ({ s, r: recorded.get(s.id)![run]! }));
      if (list.length) entry.runs[run] = tallyOf(list, kind);
    }
    evals.sets.push(entry);
  }

  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const manifest: Manifest = {
    schema: SCHEMA_VERSION,
    engine: (JSON.parse(readFileSync(join("packages", "engine", "package.json"), "utf8")) as { version: string }).version,
    protocol: PROTOCOL_VERSION,
    model: o.model?.name ?? CODE_ONLY,
    recorded: new Date().toISOString(),
    commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain").length > 0,
    counts: { scenarios: all.length, turns: turnCount, markers: Object.keys(code.markers).length },
  };
  const scen: ScenariosFile = { schema: SCHEMA_VERSION, scenarios: all };
  write("manifest.json", manifest);
  write("scenarios.json", scen);
  write("code.json", code);
  write("map.json", map);
  write("evals.json", evals);

  const problems = validateExport((f) => {
    const p = join(o.out, f);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as unknown) : undefined;
  });
  const visited = new Set([...recorded.values()].flatMap((r) => Object.values(r).flatMap((x) => x.turns.flatMap((t) => t.steps.map((st) => st.id)))));
  const unvisited = Object.keys(code.markers).filter((m) => !visited.has(m));
  return { manifest, problems, drift, unvisited };
}
