/**
 * Conversation evals (DD1): a case is a short session on a simulated desktop, played turn by turn through the real
 * actor, so context counts ("open Brave" then "search for X" must search in Brave) and so do follow-ups
 * ("close Spotify" → "confirm").
 *
 * Every turn gets one verdict:
 *   right  did what was meant
 *   asked  did nothing harmful: asked, waited, ignored, or said it can't
 *   wrong  did (or proposed, for a destructive action) something that wasn't meant
 * The wrong-action rate is the headline.
 *
 * A conversation runs on the simulated desktop (`desktop`), or on the simulated browser (`"surface": "browser"`,
 * starting on `page` from eval/browser/pages.json), or on both (`desktop` plus `browser: { page, app }`: the
 * browser lives in a desktop app, "Brave" by default; `surface` in an expectation names the one that must carry the
 * action out), or on all three (`"webapp": true`, my web app on localhost:3000 inside the browser's tab). An expected value can be "a|b" (either), "!x" (anything
 * acted on but x) or "~x" (contains x); `plan` is matched against the plan's summary and steps. A `setup` turn only
 * gets the conversation to where the scored turn starts ("click the first result", then "no, the other one"): it is
 * reported, but not counted. `"profile": false` plays a conversation with an empty profile, and `"model": false` always
 * without the model (no-model mode).
 */
import type { ActResult } from "../live/actor.ts";
import type { SimSpec } from "../sim/desktop.ts";
import type { WorldSpec } from "../sim/world.ts";
import { sameAction, type FieldResult } from "./score.ts";

export interface Turn {
  said: string;
  setup?: boolean;
  /** decision (default "act"), operation, and any slot (app, query, media, …). */
  expect: Record<string, string>;
  note?: string;
}

export interface Conversation {
  id: string;
  note?: string;
  surface?: "desktop" | "browser";
  desktop?: SimSpec;
  /** The page a browser conversation starts on. */
  page?: string;
  /** Both surfaces: the simulated browser inside a desktop app. */
  browser?: { page: string; app?: string };
  /** All three: my web app on localhost:3000, in the browser's tab (the browser's page must be on that site). */
  webapp?: boolean;
  /** false: played with an empty profile (my mishearings, phrases, nicknames and sites left out). */
  profile?: boolean;
  /** false: always played without the model, as no-model mode. */
  model?: boolean;
  /** For the demo's catalogue (eval/demo.json): a title, and tags such as "book", a chapter, or "preset". */
  title?: string;
  tags?: string[];
  turns: Turn[];
}

export type Verdict = "right" | "asked" | "wrong";

export interface TurnResult {
  conversation: string;
  index: number;
  said: string;
  verdict: Verdict;
  setup?: boolean;
  fields: FieldResult[];
  /** What happened, in a few words. */
  got: string;
  reason: string;
  /** Total time to decide (model included). */
  ms: number;
  codeOnly: boolean;
}

export function parseConversations(json: string, source = "eval"): Conversation[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error(`${source}: invalid JSON (${(err as Error).message})`);
  }
  if (!Array.isArray(data)) throw new Error(`${source}: expected an array of conversations`);
  const ids = new Set<string>();
  return data.map((c: Conversation, i) => {
    const where = c.surface === "browser" ? typeof c.page === "string" : typeof c.desktop === "object" && (!c.browser || typeof c.browser.page === "string");
    if (typeof c.id !== "string" || !Array.isArray(c.turns) || !where) {
      throw new Error(`${source}[${i}]: a conversation needs "id", "turns", and "desktop" (or "surface": "browser" and "page")`);
    }
    if (ids.has(c.id)) throw new Error(`${source}[${i}]: duplicate id "${c.id}"`);
    ids.add(c.id);
    c.turns.forEach((t, j) => {
      if (typeof t.said !== "string" || typeof t.expect !== "object" || t.expect === null) {
        throw new Error(`${source}[${i}] ${c.id} turn ${j + 1}: a turn needs "said" and "expect"`);
      }
    });
    return c;
  });
}

/** The simulated world a conversation is played in. */
export function worldOf(c: Conversation): WorldSpec {
  const profile = c.profile === false ? { profile: false } : {};
  if (c.surface === "browser") return { browser: { page: c.page! }, ...profile };
  return { desktop: c.desktop ?? {}, ...(c.browser ? { browser: c.browser } : {}), ...(c.webapp ? { webapp: true } : {}), ...profile };
}

/** "a|b" any of them, "!x" anything but x (something must be there), "~x" contains x; case doesn't matter. */
export function expected(want: string, got: string, same: (a: string, b: string) => boolean = (a, b) => a === b): boolean {
  const g = got.toLowerCase();
  if (want.startsWith("!")) return g !== "-" && !same(g, want.slice(1).toLowerCase());
  if (want.startsWith("~")) return g.includes(want.slice(1).toLowerCase());
  return want.toLowerCase().split("|").some((w) => same(g, w));
}

const NOT_SLOTS = new Set(["decision", "operation", "plan", "surface"]);

/** Compares one turn's result with what was meant, and gives the verdict. */
/** `surface`: the name of the surface that made the plan, when several are connected. */
export function judgeTurn(turn: Turn, r: ActResult, surface?: string): Pick<TurnResult, "verdict" | "fields" | "got"> {
  const o = r.outcome;
  const want = turn.expect.decision ?? "act";
  const fields: FieldResult[] = [{ field: "decision", expected: want, got: o.decision, ok: expected(want, o.decision), p: 1 }];
  const acts = o.decision === "act" || o.decision === "confirm";
  if (acts && turn.expect.operation) {
    fields.push({ field: "operation", expected: turn.expect.operation, got: o.operation, ok: expected(turn.expect.operation, o.operation, sameAction), p: 1 });
  }
  if (acts) {
    for (const [slot, want] of Object.entries(turn.expect)) {
      if (NOT_SLOTS.has(slot)) continue;
      const value = (o.slots as Record<string, unknown>)[slot];
      const got = value === undefined ? "-" : String(value);
      fields.push({ field: slot, expected: want, got, ok: expected(want, got), p: 1 });
    }
    if (turn.expect.surface) {
      fields.push({ field: "surface", expected: turn.expect.surface, got: surface ?? "-", ok: expected(`~${turn.expect.surface}`, surface ?? "-"), p: 1 });
    }
    if (turn.expect.plan) {
      const got = r.plan ? [r.plan.summary, ...r.plan.detail].join(" · ") : "-";
      fields.push({ field: "plan", expected: turn.expect.plan, got, ok: got.toLowerCase().includes(turn.expect.plan.toLowerCase()), p: 1 });
    }
  }
  const got = summarise(r);
  if (fields.every((f) => f.ok)) return { verdict: "right", fields, got };

  // Nothing happened (a question, a wait, an ignore, a plan that couldn't be made): safe, but not what was meant.
  if (!acts || !r.plan) return { verdict: "asked", fields, got };
  // The right action, only held for a confirm it didn't need: still safe.
  if (o.decision === "confirm" && fields.every((f) => f.ok || f.field === "decision")) return { verdict: "asked", fields, got };
  // A "confirm"/"cancel" with nothing waiting plans no steps: nothing happened.
  if (r.plan.detail.length === 0) return { verdict: "asked", fields, got };
  return { verdict: "wrong", fields, got };
}

function summarise(r: ActResult): string {
  const o = r.outcome;
  if (r.planError) return `can't: ${r.planError}`;
  if (r.pending) return `confirm? ${r.pending.summary}`;
  if (r.plan) return r.plan.summary;
  if (o.decision === "ask") return o.parts ? `ask: ${o.parts.length} commands` : `ask: ${o.options.map((x) => x.operation).join(" / ")}`;
  return o.decision;
}

export interface Tally {
  right: number;
  asked: number;
  wrong: number;
  n: number;
}

export function tally(results: readonly TurnResult[]): Tally {
  const t: Tally = { right: 0, asked: 0, wrong: 0, n: results.length };
  for (const r of results) t[r.verdict]++;
  return t;
}
