/**
 * The demo export's format: what `npm run export:demo` writes and the site (coreloop-site) replays. The
 * site never runs the engine: everything it shows is in these files.
 *
 *   manifest.json        what was recorded, with which engine, protocol and model, and when
 *   scenarios.json       every scenario: its world, its turns and what each turn should end in
 *   turns/<id>.json      every scenario's recorded runs (with the model, without it): views, steps, outcomes, plans
 *   code.json            every trace marker with its file and line, and the source of those files
 *   map.json             the pipeline map's data: stages, files, the flowchart's boxes, edges and labels
 *   evals.json           every eval set's results, with the model and without it, and latency
 *
 * Bump SCHEMA_VERSION on any change a reader would notice. `validateExport` checks a folder against it.
 */
import type { TraceStep } from "../core/trace.ts";
import type { Outcome } from "../core/policy.ts";
import type { Answer } from "../backends/systemone.ts";
import type { FieldResult } from "../eval/score.ts";
import type { Verdict } from "../eval/conversation.ts";
import type { WorldSpec } from "../sim/world.ts";
import type { SurfaceView } from "../surface/contract.ts";

export const SCHEMA_VERSION = 1;

/** The two ways every scenario is played: with the local model, and in no-model mode (code only). */
export type RunName = "model" | "no-model";
export const RUNS: readonly RunName[] = ["model", "no-model"];

export interface Manifest {
  schema: number;
  /** coreloop-engine's version. */
  engine: string;
  protocol: number;
  /** The model that answered the "model" runs, as its server reports it. */
  model: string;
  /** ISO date and time of the recording. */
  recorded: string;
  /** The engine repo's commit, and whether the tree had changes on top of it. */
  commit: string;
  dirty: boolean;
  counts: { scenarios: number; turns: number; markers: number };
}

/**
 * Where a scenario comes from:
 *   book    an example from the book's chapters (eval/demo.json, tag "book")
 *   preset  a playground sentence (eval/demo.json, tag "preset")
 *   tour    an eval conversation (eval/<set>.json), with the eval's verdicts
 *   case    a desktop eval case (eval/desktop.jsonl, eval/desktop-holdout.jsonl), played as one turn
 *   map     one of the pipeline map's traces (docs/pipeline-map/inputs.json)
 */
export type ScenarioKind = "book" | "preset" | "tour" | "case" | "map";

export interface ScenarioTurn {
  said: string;
  /** Only gets the conversation to the turn being scored. */
  setup?: boolean;
  /** What it should end in (the eval's expectation); none for the map's traces. */
  expect?: Record<string, string>;
}

export interface Scenario {
  /** Unique: "<set>.<id>" ("demo.book-loop-1", "daily.morning", "map.3"). Also the turns file's name. */
  id: string;
  kind: ScenarioKind;
  /** The eval set or source it comes from. */
  set: string;
  title?: string;
  note?: string;
  /** For the book: ["book", "<chapter>"]; for presets: ["preset", "<stage>"]. */
  tags?: string[];
  world: WorldSpec;
  turns: ScenarioTurn[];
  /** The runs recorded for it: both, or only "no-model" for a scenario that is about no-model mode. */
  runs: RunName[];
}

export interface ScenariosFile {
  schema: number;
  scenarios: Scenario[];
}

/** The model's part in a turn, when code couldn't decide alone. */
export interface ModelRecord {
  model: string;
  tokens: number;
  ms: number;
  /** Every question's answer: the pick, and every option with its probability. */
  answers: Record<string, Answer>;
}

export interface TurnRecord {
  said: string;
  setup?: boolean;
  /** Every step the engine took, in order (src/core/trace.ts). */
  steps: TraceStep[];
  /** What it decided. After a "confirm", the released action. */
  outcome: Outcome;
  /** What the surface planned, as people read it, or why it couldn't. */
  plan: { summary: string; steps: string[]; shows: string | null } | { error: string } | null;
  /** A destructive action now waiting for "confirm". */
  pending: string | null;
  ran: boolean;
  /** Which surface carried it out. */
  via: string | null;
  /** This turn edited the last command ("no, I meant Spotify"). */
  repair: { kind: string; from: string; to: string } | null;
  model: ModelRecord | null;
  /** What it says back: a question's hint, or what the surface reported. */
  reply: string | null;
  /** The eval's judgement, when the scenario has expectations. */
  verdict: { verdict: Verdict; fields: FieldResult[]; got: string } | null;
  /** Whole turn, view to run. */
  ms: number;
  /** Deciding alone (normalise to outcome, the model included): the eval's latency. */
  decideMs: number;
  codeOnly: boolean;
}

export interface RunRecord {
  /**
   * What the surfaces showed: views[0] before the first turn, views[i] after turn i. Each later view holds only the
   * fields that changed since the one before it (places, path, open, items).
   */
  views: Partial<SurfaceView>[];
  turns: TurnRecord[];
}

export interface TurnsFile {
  schema: number;
  id: string;
  runs: Partial<Record<RunName, RunRecord>>;
}

export interface Marker {
  stage: string;
  file: string;
  line: number;
}

export interface CodeFile {
  schema: number;
  /** Every trace marker in the source: `step("stage", "id", …)` and `ruled("stage", "id", …)`. */
  markers: Record<string, Marker>;
  /** The source of every file that holds a marker, by path. */
  files: Record<string, string>;
}

export interface MapNode {
  id: string;
  /** The node's style on the map: plain, code, model, … */
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  sub: string[];
}

export interface MapFile {
  schema: number;
  /** A stage's name → the box it belongs to ("*": every box). */
  stages: Record<string, string>;
  files: { file: string; group: string; stages: string[]; what: string; lines: number }[];
  flowchart: {
    viewBox: string;
    nodes: MapNode[];
    edges: { id: string; kind: string; d: string }[];
    labels: { id: string; lines: { x: number; y: number; text: string; anchor: string | null }[] }[];
  };
}

export interface ConversationTally {
  conversations: number;
  /** Scored turns (setup turns are left out). */
  turns: number;
  right: number;
  asked: number;
  wrong: number;
  codeOnly: number;
  p50: number;
  p95: number;
}

export interface CaseTally {
  cases: number;
  pass: number;
  /** Destructive requests acted on without a confirm (must be 0). */
  unsafe: number;
  codeOnly: number;
  p50: number;
  p95: number;
}

export interface EvalsFile {
  schema: number;
  model: string;
  sets: { set: string; kind: "conversation" | "case"; runs: Partial<Record<RunName, ConversationTally | CaseTally>> }[];
}

const MS = /\b\d+(?:\.\d+)? ms\b/g;
const TIMING = new Set(["t", "ms", "decideMs", "latencyMs", "totalMs", "codeMs", "startedAt", "runMs", "p50", "p95", "recorded"]);

/**
 * Differences between two recordings of the same scenario, ignoring timings (fields and "… ms" in notes): a decision,
 * step or plan that changed is a difference; a probability that moved by less than 0.001 (the GPU's rounding) is not.
 */
export function differences(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
  if (out.length >= 10) return out;
  if (typeof a === "number" && typeof b === "number") {
    if (Math.abs(a - b) > 1e-3) out.push(`${path}: ${a} ≠ ${b}`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: ${a.length} items ≠ ${b.length}`);
    else a.forEach((x, i) => differences(x, b[i], `${path}[${i}]`, out));
  } else if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!TIMING.has(k)) differences((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k, out);
  } else if (typeof a === "string" && typeof b === "string") {
    // a note may say how long something took ("answered in 123 ms")
    if (a.replace(MS, "… ms") !== b.replace(MS, "… ms")) out.push(`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  } else if (a !== b) out.push(`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  return out;
}

/** Everything an export folder must hold, read through `read` (a file name → its parsed JSON, or undefined). */
export function validateExport(read: (file: string) => unknown): string[] {
  const problems: string[] = [];
  const need = <T>(file: string): T | undefined => {
    const v = read(file) as (T & { schema?: number }) | undefined;
    if (v === undefined) problems.push(`${file}: missing`);
    else if (v.schema !== SCHEMA_VERSION) problems.push(`${file}: schema ${v.schema}, expected ${SCHEMA_VERSION}`);
    return v;
  };
  const manifest = need<Manifest>("manifest.json");
  const scen = need<ScenariosFile>("scenarios.json");
  const code = need<CodeFile>("code.json");
  const map = need<MapFile>("map.json");
  const evals = need<EvalsFile>("evals.json");
  if (!manifest || !scen || !code || !map || !evals) return problems;

  for (const k of ["engine", "model", "recorded", "commit"] as const) if (typeof manifest[k] !== "string" || !manifest[k]) problems.push(`manifest.json: no ${k}`);
  if (typeof manifest.protocol !== "number") problems.push("manifest.json: no protocol");

  for (const [id, m] of Object.entries(code.markers)) {
    if (typeof code.files[m.file] !== "string") problems.push(`code.json: marker ${id} is in ${m.file}, which isn't included`);
    else if (!(code.files[m.file]!.split("\n")[m.line - 1] ?? "").includes(`"${id}"`)) {
      problems.push(`code.json: marker ${id} isn't at ${m.file}:${m.line}`);
    }
  }

  const ids = new Set<string>();
  let turns = 0;
  for (const s of scen.scenarios) {
    if (ids.has(s.id)) problems.push(`scenarios.json: duplicate id ${s.id}`);
    ids.add(s.id);
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(s.id)) problems.push(`scenarios.json: ${s.id} isn't a safe file name`);
    if (!s.world || (!s.world.desktop && !s.world.browser)) problems.push(`${s.id}: no world`);
    if (!s.turns.length) problems.push(`${s.id}: no turns`);
    if (!s.runs.length || s.runs.some((r) => !RUNS.includes(r))) problems.push(`${s.id}: bad runs ${JSON.stringify(s.runs)}`);
    const file = read(`turns/${s.id}.json`) as TurnsFile | undefined;
    if (!file) {
      problems.push(`turns/${s.id}.json: missing`);
      continue;
    }
    if (file.schema !== SCHEMA_VERSION || file.id !== s.id) problems.push(`turns/${s.id}.json: wrong schema or id`);
    for (const run of s.runs) {
      const r = file.runs[run];
      if (!r) {
        problems.push(`${s.id}: no ${run} run`);
        continue;
      }
      if (r.turns.length !== s.turns.length) problems.push(`${s.id} ${run}: ${r.turns.length} turns recorded, ${s.turns.length} in the scenario`);
      if (r.views.length !== r.turns.length + 1) problems.push(`${s.id} ${run}: ${r.views.length} views for ${r.turns.length} turns`);
      r.turns.forEach((t, i) => {
        turns++;
        if (t.said !== s.turns[i]?.said) problems.push(`${s.id} ${run} #${i + 1}: said "${t.said}", the scenario says "${s.turns[i]?.said}"`);
        if (!t.steps.length) problems.push(`${s.id} ${run} #${i + 1}: no steps`);
        for (const st of t.steps) if (!code.markers[st.id]) problems.push(`${s.id} ${run} #${i + 1}: step ${st.id} has no marker in code.json`);
        if (!t.outcome?.decision) problems.push(`${s.id} ${run} #${i + 1}: no outcome`);
        if (s.turns[i]?.expect && !t.verdict) problems.push(`${s.id} ${run} #${i + 1}: expected something but has no verdict`);
        if (run === "no-model" && t.model) problems.push(`${s.id} no-model #${i + 1}: the model answered`);
      });
    }
  }
  if (manifest.counts.scenarios !== scen.scenarios.length) problems.push(`manifest.json: ${manifest.counts.scenarios} scenarios, scenarios.json has ${scen.scenarios.length}`);
  if (manifest.counts.turns !== turns) problems.push(`manifest.json: ${manifest.counts.turns} turns, the runs hold ${turns}`);

  const boxes = new Set(map.flowchart.nodes.map((n) => n.id));
  for (const [stage, box] of Object.entries(map.stages)) if (box !== "*" && !boxes.has(box)) problems.push(`map.json: stage ${stage} points at ${box}, which isn't drawn`);
  for (const f of map.files) for (const st of f.stages) if (!map.stages[st]) problems.push(`map.json: ${f.file} names stage ${st}, which has no box`);
  for (const m of Object.values(code.markers)) if (!map.stages[m.stage]) problems.push(`code.json: stage ${m.stage} (${m.file}:${m.line}) has no box on the map`);
  if (!evals.sets.length) problems.push("evals.json: no sets");
  return problems.slice(0, 50);
}
