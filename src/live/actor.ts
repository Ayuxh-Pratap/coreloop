/**
 * The actor: one utterance in, the right thing done on whatever surface is connected. Shared by `npm run
 * repl` (typed) and `npm run live` (spoken), so both run exactly the same decide → plan → confirm → run path.
 *
 * The surface (src/surface/contract.ts) says what's in use and what it can do, plans a decided action, and runs
 * it. Everything here is the core's and the same for every surface:
 *  - a destructive action is planned when it's decided (so the confirm prompt can name exactly what will happen)
 *    and that same plan runs on "confirm", even if things changed in between;
 *  - context: the app in use (or the one this actor just opened, while its window is on its way) is the target
 *    unless the words name another;
 *  - memory: the last command, for about a minute, so "no, I meant Claude Code", "no, search on Brave",
 *    "not Panther, Pantera", "its music" and "undo that" refer to it;
 *  - the last pick among the surface's items, so "no, the other one" picks again without it;
 *  - two failed questions in a row: it says what it can do here and stops asking;
 *  - two commands in one sentence run in a row when each one is decided by code ("open Spotify and search for
 *    Panther"): the second is planned in the app the first one shows.
 */
import { APP_NOUNS } from "../core/apps.ts";
import type { Decider } from "../backends/systemone.ts";
import type { AppEntry } from "../core/apps.ts";
import { normalise } from "../core/normalise.ts";
import { step } from "../core/trace.ts";
import { understand, understandByCode, type Understood } from "../core/pipeline.ts";
import { NUMBER_WORDS, Session, whatICanDo, type Outcome } from "../core/policy.ts";
import { parseRepair, type Repair } from "../core/repair.ts";
import type { SlotContext } from "../core/slots.ts";
import { SkillSet } from "../skills/skillset.ts";
import { parseSkills } from "../skills/validate.ts";
import { PlanError, type Decided, type Plan, type Surface, type SurfaceView, type Assume } from "../surface/contract.ts";

/** How long the last command can still be repaired or undone, and an opened app counts as "just opened". */
const MEMORY_MS = 60_000;
const RECENT_MS = 15_000;

/** What `Actor.handle()` returns: what was understood, the outcome, and what the surface planned and did. */
export interface ActResult {
  /** The normalised text, where it went, the model's answers if it was asked, and timings. */
  understood: Understood;
  /** The outcome after the session (a "confirm" becomes the released action). */
  outcome: Outcome;
  /** What the surface planned. */
  plan?: Plan;
  /** Why the surface couldn't plan it, in words (from a `PlanError`). */
  planError?: string;
  /** The plan actually ran (false in dry run, on errors, and for anything but act). */
  ran: boolean;
  /** Why running it failed, in words. */
  runError?: string;
  /** What the surface said ("Playing Panther on Spotify"). */
  notes?: string[];
  /** The plan now waiting for a spoken "confirm". */
  pending?: Plan;
  /** This utterance edited the previous command: what it was, what it became. */
  repair?: { kind: Repair["kind"]; from: string; to: string };
  /** `performance.now()` when the plan started running. */
  startedAt?: number;
  /** How long running the plan took, in milliseconds. */
  runMs?: number;
}

/** What an `Actor` needs: something that decides, and somewhere to act. */
export interface ActorOptions {
  /** The decision model: `SystemOneClient`, `CodeOnlyDecider`, `FallbackDecider`, or anything that answers a request. */
  client: Decider;
  /** Where actions happen. For several surfaces, pass `new Surfaces([...])`. */
  surface: Surface;
  /** Plan and show, but run nothing. */
  dryRun?: boolean;
  /** The clock for confirms and memory, in milliseconds. For tests. */
  now?: () => number;
}

interface Memory {
  /** The command as it was finally understood (normalised words, target words included). */
  text: string;
  /** The command without its target words, and the app it was for. */
  scopeText: string;
  target?: string;
  outcome: Outcome;
  at: number;
  /** How to reverse what ran, when that is safe and known. */
  undo?: Plan;
  /** This command picked an item. */
  pick?: ItemPick;
}

/** A command that picked one of the surface's items ("click the first result"), for "no, the other one". */
interface ItemPick {
  text: string;
  item: string;
  label?: string;
  /** Items already ruled out by earlier "the other one"s. */
  exclude: string[];
  at: number;
}

/**
 * Runs the whole loop for one surface. It hears a sentence, decides with code first and the model only when code
 * can't, then has the surface plan and run the action, or holds a destructive one for a spoken "confirm". It remembers
 * the last command, so "no, I meant spotify" and "undo that" work. The surface's skills are checked when it's created.
 *
 * @example
 * const actor = new Actor({ client: new CodeOnlyDecider(), surface: new TasksSurface() });
 * const r = await actor.handle("delete buy milk");
 * r.outcome.decision; // "confirm"
 * r.pending?.summary; // 'delete "Buy milk"'
 * await actor.handle("confirm"); // runs exactly that plan
 *
 * @throws {SkillError} when the surface's skills aren't valid data.
 */
export class Actor {
  /** Confirms and answers held between sentences. */
  readonly session: Session;
  /** The surface's skills, as the engine uses them. */
  readonly skills: SkillSet;
  private pendingPlan: Plan | undefined;
  private readonly opts: ActorOptions;
  private last: Memory | undefined;
  private lastPick: ItemPick | undefined;
  /** The app this actor last brought to the front, and what was in use before. */
  private recent: { app: string; at: number; before?: string } | undefined;
  private asksInARow = 0;
  /** The names the surface knows, from its last view. */
  apps: readonly AppEntry[] = [];

  constructor(opts: ActorOptions) {
    this.opts = opts;
    // skills are data, checked once: an in-process surface gets the same checks as one over the wire
    parseSkills(opts.surface.skills, `${opts.surface.name} skills`);
    this.skills = new SkillSet(opts.surface.skills, opts.surface.operations);
    this.session = new Session(this.skills, () => this.now());
  }

  /** The plan waiting for a spoken "confirm", if any. */
  get pending(): Plan | undefined {
    return this.pendingPlan;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Starts reading the surface now, such as when the push-to-talk key is released, while speech-to-text runs. */
  prefetch(): void {
    this.opts.surface.prefetch?.();
  }

  /** What the surface sees, with the place this actor just opened counted while nothing else came to the front. */
  private async view(): Promise<SurfaceView> {
    const v = await this.opts.surface.view();
    this.apps = v.places;
    const r = this.recent;
    const at = v.path?.at(-1);
    if (r && this.now() - r.at < RECENT_MS && !v.path?.includes(r.app) && at === r.before) return { ...v, path: [r.app] };
    return v;
  }

  private async plan(outcome: Decided, assume?: Assume): Promise<{ plan?: Plan; planError?: string }> {
    try {
      return { plan: await this.opts.surface.plan(outcome, assume) };
    } catch (err) {
      if (err instanceof PlanError) return { planError: err.message };
      throw err;
    }
  }

  private async run(plan: Plan): Promise<Pick<ActResult, "ran" | "runError" | "startedAt" | "runMs" | "notes">> {
    if (this.opts.dryRun) return { ran: false };
    const startedAt = performance.now();
    try {
      const receipt = await this.opts.surface.run(plan);
      if (!receipt.ok) return { ran: false, runError: receipt.error ?? "the surface couldn't do it", startedAt };
      return { ran: true, startedAt, runMs: performance.now() - startedAt, ...(receipt.notes?.length ? { notes: [...receipt.notes] } : {}) };
    } catch (err) {
      return { ran: false, runError: (err as Error).message, startedAt };
    }
  }

  /**
   * Handles one sentence: decides, then plans and runs it, or holds the plan for "confirm". A "confirm" must be the
   * very next thing said, within 30 seconds.
   * @param text What was said, as text.
   * @param signal Cancels a pending model request.
   */
  async handle(text: string, signal?: AbortSignal): Promise<ActResult> {
    const last = this.last && this.now() - this.last.at < MEMORY_MS ? this.last : undefined;
    const leading = this.skills.leadingWords();
    step("repairs", "actor.repair-check", 'first: is this a repair of the last command ("no, I meant …", "undo that")?', { last: last?.text });
    const said = normalise(text, leading).text;
    if (this.apps.length === 0) this.apps = (await this.opts.surface.view()).places;
    const repair = parseRepair(said, this.apps, Boolean(last && "slots" in last.outcome && (last.outcome.slots.query || last.outcome.slots.span)), leading);
    if (repair) {
      step("repairs", "actor.repair", `a repair of the last command: ${repair.kind}`, { repair, last: last?.text });
      if (repair.kind === "undo") return this.undo(text, last);
      if (repair.kind === "other") return this.other(text, signal);
      const edited = last ? applyRepair(repair, last) : repair.kind === "again" ? repair.text : undefined;
      if (edited !== undefined) {
        const r = await this.act(edited, signal);
        return { ...r, repair: { kind: repair.kind, from: last?.text ?? "", to: edited } };
      }
    }
    return this.act(text, signal);
  }

  private async act(text: string, signal?: AbortSignal, excludeItems?: string[]): Promise<ActResult> {
    const view = await this.view();
    // where the user is: the innermost place on the path is where a command goes when the words name none
    const front = view.path?.at(-1);
    const last = this.last && this.now() - this.last.at < MEMORY_MS ? this.last : undefined;
    // only a real name the user said, never a placeholder like "@current"
    const said = last && "slots" in last.outcome ? last.outcome.slots.query : undefined;
    const lastQuery = said && !said.startsWith("@") ? said : undefined;
    const ctx: SlotContext = { apps: view.places, skills: this.skills, front, path: view.path, open: view.open, lastQuery, items: view.items, excludeItems };
    step("view", "actor.view", "what the surfaces see now: where I am, what's open, what can be named", {
      path: view.path,
      open: view.open,
      places: view.places.length,
      items: view.items?.length ?? 0,
      ...(lastQuery ? { lastQuery } : {}),
    });
    const understood = await understand(this.opts.client, text, { ctx, signal });
    let decided = understood.outcome;

    if (decided.decision === "ask" && decided.parts) {
      const two = await this.inARow(decided.parts, ctx, understood);
      if (two) return two;
    }
    // Two questions in a row that didn't get anywhere: say what it can do here, and stop asking.
    if (decided.decision === "ask" && !decided.parts) {
      this.asksInARow++;
      if (this.asksInARow >= 2) decided = { ...decided, choices: undefined, hint: whatICanDo({ ...ctx, target: understood.scope.target }), reason: `${decided.reason}; second question in a row` };
    } else this.asksInARow = 0;

    const outcome = this.session.handle(decided);
    // the session dropped what was held: so does the plan behind it
    if (!this.session.pending && !(outcome.decision === "act" && outcome.confirmed)) this.pendingPlan = undefined;
    const base = { understood, outcome, ran: false };
    const remember = (r: ActResult, undo?: Plan): ActResult => {
      if (outcome.decision === "act" || outcome.decision === "confirm" || outcome.decision === "ask") {
        const item = "slots" in outcome ? outcome.slots.item : undefined;
        const pick = item ? { text: understood.norm.text, item, label: outcome.decision !== "ask" ? outcome.slots.item_label : undefined, exclude: excludeItems ?? [], at: this.now() } : undefined;
        if (pick) this.lastPick = pick;
        this.last = { text: understood.norm.text, scopeText: understood.scope.text, target: understood.scope.target?.app, outcome, at: this.now(), undo, pick };
      }
      if (r.ran && r.plan?.shows) this.recent = { app: r.plan.shows, at: this.now(), before: front };
      return r;
    };

    if (outcome.decision === "act" && outcome.confirmed) {
      const plan = this.pendingPlan;
      this.pendingPlan = undefined;
      if (!plan) return base;
      const ran = await this.run(plan);
      step("run", "actor.run-confirmed", ran.ran ? `the plan held for the confirm ran: ${plan.summary}` : `not run: ${ran.runError ?? "dry run"}`, { summary: plan.summary, ran: ran.ran });
      return remember({ ...base, plan, ...ran });
    }
    if (outcome.decision === "act") {
      this.pendingPlan = undefined;
      const { plan, planError } = await this.plan(outcome);
      step("plan", "actor.plan", plan ? `the surface's plan: ${plan.summary}` : `the surface can't: ${planError}`, plan ? { summary: plan.summary, steps: plan.detail, shows: plan.shows } : { error: planError });
      if (!plan) return remember({ ...base, planError });
      const ran = await this.run(plan);
      step("run", "actor.run", ran.ran ? "done" : `not run: ${ran.runError ?? "dry run"}`, { ran: ran.ran, ...(ran.notes ? { notes: ran.notes } : {}) });
      return remember({ ...base, plan, ...ran }, ran.ran ? plan.undo : undefined);
    }
    if (outcome.decision === "confirm") {
      const { plan, planError } = await this.plan(outcome);
      if (!plan) {
        this.session.pending = undefined;
        this.pendingPlan = undefined;
        return { ...base, planError };
      }
      this.pendingPlan = plan;
      step("plan", "actor.hold-plan", `planned, not run: "${plan.summary}" waits for "confirm", and "confirm" runs exactly this plan`, { summary: plan.summary, steps: plan.detail });
      return remember({ ...base, plan, pending: plan });
    }
    if (outcome.decision === "ignore" && outcome.reason.startsWith("cancelled")) this.pendingPlan = undefined;
    return remember(base);
  }

  /**
   * "open spotify and search for panther": every part decided by code, none destructive; the next part is planned
   * in the app the previous part brings to the front. Otherwise undefined (the question stays).
   */
  private async inARow(parts: string[], ctx: SlotContext, understood: Understood): Promise<ActResult | undefined> {
    let front = ctx.front;
    const plans: Plan[] = [];
    let lastOutcome: Outcome | undefined;
    for (const part of parts) {
      const u = understandByCode(part, { ...ctx, front, path: front !== ctx.front && front ? [front] : ctx.path, target: undefined });
      if (!u || u.outcome.decision !== "act" || ["confirm", "cancel", "choose"].includes(u.outcome.operation)) return undefined;
      const { plan } = await this.plan(u.outcome, front !== ctx.front && front ? { path: [front] } : undefined);
      if (!plan) return undefined;
      plans.push(plan);
      lastOutcome = u.outcome;
      if (plan.shows) front = plan.shows;
    }
    // one plan: each part's steps in order, with a pause for the app the previous part opened
    const plan: Plan = {
      summary: plans.map((p) => p.summary).join(", then "),
      detail: plans.flatMap((p, i) => (i ? ["wait for it to open", ...p.detail] : [...p.detail])),
      shows: front !== ctx.front ? front : undefined,
      data: plans,
    };
    const outcome: Outcome = { ...lastOutcome!, reason: `${parts.length} commands in a row, each decided by code` } as Outcome;
    this.session.handle(outcome);
    this.asksInARow = 0;
    const ran = await this.runAll(plans);
    this.last = { text: parts.at(-1)!, scopeText: parts.at(-1)!, target: front, outcome, at: this.now() };
    if (ran.ran && front) this.recent = { app: front, at: this.now(), before: ctx.front };
    return { understood, outcome, plan, ...ran };
  }

  /** Several plans in a row; stops at the first that fails. */
  private async runAll(plans: readonly Plan[]): Promise<Pick<ActResult, "ran" | "runError" | "startedAt" | "runMs" | "notes">> {
    const startedAt = performance.now();
    const notes: string[] = [];
    for (const p of plans) {
      const r = await this.run(p);
      if (!r.ran) return { ...r, startedAt };
      notes.push(...(r.notes ?? []));
    }
    return { ran: !this.opts.dryRun, startedAt, runMs: performance.now() - startedAt, ...(notes.length ? { notes } : {}) };
  }

  /**
   * "No, the other one": the last pick again, without the item it picked (and the ones ruled out before). If that
   * pick was the last command, it's undone first ("click the first result" went to the wrong page: go back).
   */
  private async other(text: string, signal?: AbortSignal): Promise<ActResult> {
    const pick = this.lastPick && this.now() - this.lastPick.at < MEMORY_MS ? this.lastPick : undefined;
    if (!pick) {
      const norm = normalise(text);
      const outcome: Outcome = { decision: "ask", options: [], reason: "other: nothing was picked", hint: "There's nothing I picked to swap for another one." };
      return { understood: { norm, scope: { text: norm.text }, outcome, codeMs: 0, totalMs: 0 }, outcome, ran: false };
    }
    if (this.last?.pick === pick && this.last.undo) await this.run(this.last.undo);
    const r = await this.act(pick.text, signal, [...pick.exclude, pick.item]);
    return { ...r, repair: { kind: "other", from: pick.text, to: `${pick.text}, not "${pick.label ?? pick.item}"` } };
  }

  private async undo(text: string, last: Memory | undefined): Promise<ActResult> {
    const norm = normalise(text);
    const reply = (outcome: Outcome): Understood => ({ norm, scope: { text: norm.text }, outcome, codeMs: 0, totalMs: 0 });
    if (!last?.undo) {
      const what = last && "operation" in last.outcome ? `"${last.text}"` : "the last command";
      const outcome: Outcome = { decision: "ask", options: [], reason: "undo: nothing reversible", hint: `I can't undo ${what} yet.` };
      return { understood: reply(outcome), outcome, ran: false };
    }
    const plan = last.undo;
    this.last = undefined;
    const outcome: Outcome = { decision: "act", operation: "undo", slots: {}, reason: `undo "${last.text}"` };
    return { understood: reply(outcome), outcome, plan, ...(await this.run(plan)) };
  }
}

/** The previous command, edited by a repair; undefined when the repair doesn't apply to it. */
export function applyRepair(repair: Repair, last: Pick<Memory, "text" | "scopeText" | "outcome">): string | undefined {
  switch (repair.kind) {
    case "again":
      return repair.text;
    case "target":
      return repair.target === "here" ? `${last.scopeText} in this window` : `${last.scopeText} on ${repair.target}`;
    case "name": {
      const app = "slots" in last.outcome ? last.outcome.slots.app : undefined;
      const phrase = nameIn(last.scopeText) ?? (app ? app.toLowerCase() : undefined);
      if (!phrase || !last.text.includes(phrase)) return `${verbOf(last.scopeText)} ${repair.name}`;
      return last.text.replace(phrase, repair.name);
    }
    case "query": {
      const q = "slots" in last.outcome ? (last.outcome.slots.query ?? last.outcome.slots.span) : undefined;
      if (!q) return undefined;
      const i = last.text.lastIndexOf(q.split(" ")[0]!);
      return i < 0 ? undefined : last.text.slice(0, i) + repair.query + last.text.slice(i + q.length);
    }
    case "swap":
      return last.text.includes(repair.from) ? last.text.replace(repair.from, repair.to) : undefined;
    case "undo":
    case "other":
      return undefined;
  }
}

const VERB = /^(?:open|launch|start|switch to|go to|bring up|show me|focus on|focus|close|bring|put)\b/;

const NAME_IN = new RegExp(
  `^(?:open|launch|start|run|switch to|switch back to|go to|go back to|bring up|show me|show|focus on|focus|close|quit|bring|put|get|move) (?:up |the |my )?(.+?)(?: (?:on top|to the front|${APP_NOUNS.join("|")}))?$`,
);

/** The words after the verb that named an app ("open crawled code" → "crawled code"). */
function nameIn(text: string): string | undefined {
  const m = NAME_IN.exec(text);
  return m?.[1];
}

function verbOf(text: string): string {
  return VERB.exec(text)?.[0] ?? "open";
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What was heard, as the user would recognise it (speech-to-text's words, not the cleaned-up ones). */
function heard(r: ActResult): string {
  return r.understood.norm.raw.trim().replace(/[.!?]+$/, "");
}

/** One line a person can act on: what happened, or what was heard and what to say next. */
export function describe(r: ActResult): string {
  const o = r.outcome;
  const fixed = r.repair ? `(→ "${r.repair.to}") ` : "";
  if (r.pending) return `${fixed}Say "confirm" to ${r.pending.summary}, or "cancel".`;
  if (r.planError) return `Heard "${heard(r)}": ${r.planError}.`;
  if (r.runError) return `Tried to ${r.plan?.summary ?? o.decision}, but: ${r.runError}`;
  if (r.plan) {
    if (!r.ran) return `${fixed}Would ${r.plan.summary} (dry run).`;
    return `${fixed}${r.notes?.length ? r.notes.join(". ") : capitalise(r.plan.summary)}`;
  }
  switch (o.decision) {
    case "ask": {
      if (o.parts) return `That's ${o.parts.length} commands, and I can only run them together when each one is clear. Say them one at a time: ${o.parts.map((p, i) => `${i + 1}) ${p}`).join("  ")}`;
      if (o.choices?.length === 1) return `Heard "${heard(r)}". ${capitalise(o.choices[0]!.label)}? Say "yes".`;
      if (o.choices?.length) return `Heard "${heard(r)}". Did you mean ${o.choices.map((c, i) => `${i + 1}) ${c.label}`).join("  ")}? Say ${o.choices.map((_, i) => `"${NUMBER_WORDS[i]}"`).join(" or ")}.`;
      if (o.hint) return `Heard "${heard(r)}": ${o.hint}`;
      return `Heard "${heard(r)}", but I'm not sure what to do.`;
    }
    case "wait":
      return "Waiting for the rest of the sentence.";
    case "ignore":
      if (o.reason.startsWith("cancelled")) return "Cancelled.";
      if (o.reason.includes("was dropped: you said")) return "Nothing to confirm: something else was said first, so the last action was dropped. Say it again.";
      if (o.reason.includes("was dropped: it waited")) return "Nothing to confirm: the last action waited too long and was dropped. Say it again.";
      if (o.reason.includes("nothing is waiting")) return "Nothing to confirm or cancel.";
      if (o.reason.includes("nothing was asked")) return "Nothing was asked.";
      if (o.reason.endsWith("is not voice-accessible")) return `Heard "${heard(r)}": that can't be done by voice.`;
      return "Not a command, ignored.";
    default:
      return o.reason;
  }
}
