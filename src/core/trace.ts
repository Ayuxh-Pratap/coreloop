/*
 * The engine's trace: what each step was given, what it decided, and why, for the playground and the pipeline map.
 * Off by default: every `step()` is one check of a module variable, and a trace never changes a decision.
 *
 * Each step names its box on the map (`stage`, one of the map's STAGES) and a stable marker (`id`). The marker is
 * the string literal at the call in the source, so a viewer finds the exact line by searching for it: no line
 * numbers to drift.
 *
 *   const { value, steps } = await traced(() => actor.handle("open settings"));
 */

/** One step of a trace. */
export interface TraceStep {
  /** The box on the pipeline map: "normalise", "which app", "code first", "model", "policy", "session"… */
  stage: string;
  /** A stable marker, the same string as at the call in the source: "policy.app-verb". */
  id: string;
  /** What happened, in words. */
  note: string;
  /** What went in and came out, as plain JSON. */
  data?: Record<string, unknown>;
  /** Milliseconds since the trace began. */
  t: number;
}

let current: { steps: TraceStep[]; t0: number } | undefined;

/** Whether a trace is being recorded: check it before building costly data for a step. */
export function tracing(): boolean {
  return current !== undefined;
}

/** Records one step, when a trace is being recorded. */
export function step(stage: string, id: string, note: string, data?: Record<string, unknown>): void {
  if (!current) return;
  current.steps.push({ stage, id, note, ...(data ? { data: plain(data) } : {}), t: Math.round((performance.now() - current.t0) * 100) / 100 });
}

/**
 * Runs `fn` while recording every decision the engine makes, with a stable id for each that is also at its line in
 * the source. Tracing never changes a decision. One trace at a time.
 *
 * @example
 * const { value, steps } = await traced(() => actor.handle("open spotify"));
 * for (const s of steps) console.log(s.stage, s.id, s.note);
 */
export async function traced<T>(fn: () => Promise<T> | T): Promise<{ value: T; steps: TraceStep[] }> {
  if (current) throw new Error("a trace is already being recorded");
  const rec = { steps: [] as TraceStep[], t0: performance.now() };
  current = rec;
  try {
    const value = await fn();
    return { value, steps: rec.steps };
  } finally {
    current = undefined;
  }
}

/** Plain JSON, so a step shows what the data was then, not what it became; long lists are cut. */
function plain(data: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(data, (_k, v: unknown) => (Array.isArray(v) && v.length > 40 ? [...v.slice(0, 40), `… ${v.length - 40} more`] : v)),
  ) as Record<string, unknown>;
}
