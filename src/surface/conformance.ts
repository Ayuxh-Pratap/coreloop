/**
 * The conformance suite: what any surface must do to be driven by the core, the same in-process and over the
 * connection. Each check gives a name, a pass, and what went wrong.
 *
 *   1. skills and operations are valid data (they survive JSON and the skill validator)
 *   2. the view has the contract's shape, as JSON
 *   3. planning changes nothing (the view, and anything else the caller can observe, is the same after)
 *   4. plans are JSON and say what they will do (a summary and steps in words)
 *   5. an action the surface doesn't know is refused with a PlanError, not another failure
 *   6. a plan held for a while still runs as it was shown (planned, other things run, then run as JSON)
 *   7. every run brings a receipt back, in time
 *
 * Running plans acts on the surface. On a real desktop pass only samples that are safe to run, or `run: false`.
 */
import { ALL_COMMON } from "../core/operations.ts";
import { parseSkills } from "../skills/validate.ts";
import { PlanError, type Decided, type Plan, type Receipt, type Surface } from "./contract.ts";
import { parsePlan, parseReceipt, parseView } from "./protocol.ts";

/** One conformance check: its name, whether it passed, and what went wrong. */
export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Options for `conformance()`. */
export interface ConformanceOptions {
  /**
   * Actions to plan (default: one of each supported common operation with harmless values, and each skill action
   * whose sentences need no words). A surface whose actions all take words passes its own.
   */
  samples?: readonly Decided[];
  /** Run the planned samples (default false: planning only). */
  run?: boolean;
  /** Anything else that must not change while planning (a simulator's step log). */
  observe?: () => unknown;
  /** How long a run may take. */
  runTimeoutMs?: number;
}

const act = (operation: string, slots: Decided["slots"]): Decided => ({ decision: "act", operation, slots, reason: "conformance" });

/** One harmless action per common operation the surface supports, and each skill action that needs no words. */
export function defaultSamples(surface: Surface): Decided[] {
  const ops = surface.operations ?? ALL_COMMON;
  const all: Decided[] = [
    act("press_key", { key: "escape" }),
    act("media", { media: "play_pause" }),
    act("open_url", { url: "example.com" }),
    act("search_web", { span: "conformance test" }),
    act("type_text", { span: "hello" }),
  ];
  const fixed = surface.skills.flatMap((s) =>
    s.actions
      .filter((a) => a.risk !== "never" && [...a.templates, ...(a.anywhere ?? [])].every((t) => !(typeof t === "string" ? t : t.t).includes("{")))
      .map((a) => act(a.id, s.places[0] ? { app: s.places[0] } : {})),
  );
  return [...all.filter((a) => ops.includes(a.operation)), ...fixed];
}

/** Two JSON values are the same (they come out of `json`, so key order is stable). No Node needed. */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const json = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms))]);
}

/**
 * Checks a surface against the contract: its skills are valid data, its view has the contract's shape, planning
 * changes nothing, plans are JSON and say what they'll do, an unknown action is refused with a `PlanError`, a held
 * plan still runs as shown, and every run reports back in time.
 *
 * @example
 * for (const c of await conformance(new TasksSurface(), { samples })) console.log(c.ok ? "✔" : "✖", c.name);
 */
export async function conformance(surface: Surface, opts: ConformanceOptions = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const check = async (name: string, f: () => Promise<string | undefined> | string | undefined) => {
    try {
      const problem = await f();
      checks.push(problem ? { name, ok: false, detail: problem } : { name, ok: true });
    } catch (err) {
      checks.push({ name, ok: false, detail: (err as Error).message });
    }
  };
  const samples = opts.samples ?? defaultSamples(surface);

  await check("skills and operations are valid data", () => {
    parseSkills(json(surface.skills), `${surface.name} skills`);
    const bad = (surface.operations ?? []).filter((o) => !ALL_COMMON.includes(o));
    return bad.length ? `not common operations: ${bad.join(", ")}` : undefined;
  });

  await check("the view has the contract's shape", async () => {
    const v = await surface.view();
    parseView(json(v));
    return same(json(v), json(await surface.view())) ? undefined : "two views in a row differ with nothing done";
  });

  const plans: Plan[] = [];
  await check("planning changes nothing", async () => {
    const before = json(await surface.view());
    const seen = json(opts.observe?.());
    for (const s of samples) {
      try {
        plans.push(await surface.plan(s));
      } catch (err) {
        if (!(err instanceof PlanError)) throw err;
      }
    }
    if (!same(before, json(await surface.view()))) return "the view changed while planning";
    if (!same(seen, json(opts.observe?.()))) return "something observable changed while planning";
    // no samples (every action takes words): nothing to check here; pass `samples` to check planning
    return plans.length || !samples.length ? undefined : "none of the samples could be planned";
  });

  await check("plans are JSON and say what they will do", () => {
    for (const p of plans) {
      parsePlan(json(p));
      if (!p.summary.trim()) return "a plan has no summary";
      if (!same(json(p), json(json(p)))) return `"${p.summary}" doesn't survive JSON`;
    }
    return undefined;
  });

  await check("an unknown action is refused with a PlanError", async () => {
    try {
      await surface.plan(act("conformance.no_such_action", {}));
      return "it was planned";
    } catch (err) {
      return err instanceof PlanError ? undefined : `failed with ${(err as Error).name}: ${(err as Error).message}`;
    }
  });

  if (opts.run && plans.length) {
    const ms = opts.runTimeoutMs ?? 5000;
    const receipts: Receipt[] = [];
    await check("a plan held for a while still runs as it was shown", async () => {
      const held = json(plans[0]!);
      for (const p of plans.slice(1)) receipts.push(await within(surface.run(json(p)), ms, "a run"));
      const r = await within(surface.run(held), ms, "the held plan");
      receipts.push(r);
      return r.ok ? undefined : `the held plan failed: ${r.error ?? "no reason"}`;
    });
    await check("every run brings a receipt back, in time", () => {
      for (const r of receipts) parseReceipt(json(r));
      return receipts.length === plans.length ? undefined : `${receipts.length} receipts for ${plans.length} runs`;
    });
  }
  return checks;
}
