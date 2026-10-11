/**
 * One utterance through every stage that doesn't touch the outside world:
 *   raw text → normalise → [code-only decision | decision request → model → policy] → outcome
 * Used by the eval, the `say` CLI and (from M6) the live loop, so all three measure the same thing.
 *
 * Before deciding, the target app is resolved (core/scope.ts): "search for panther on spotify" is decided as
 * "search for panther" with Spotify as the target, and the model also gets Spotify's actions to pick from.
 */
import type { Decider, Decision } from "../backends/systemone.ts";
import { normalise, type Normalised } from "./normalise.ts";
import { decide, decideWithoutModel, type Outcome, targetPath } from "./policy.ts";
import { buildRequest, type RequestOptions } from "./questions.ts";
import { resolveScope, type Scope } from "./scope.ts";
import { commonOnly } from "../skills/skillset.ts";
import { isPassword, itemsFor, pickOptions } from "./items.ts";
import { NO_CONTEXT, type SlotContext } from "./slots.ts";
import { step, tracing } from "./trace.ts";

/** What a sentence was understood to mean, before anything is planned. */
export interface Understood {
  /** The sentence after normalising. */
  norm: Normalised;
  /** The place the command is for, and the command without the words that named it. */
  scope: Scope;
  /** The model's answers. Undefined when code decided without asking the model. */
  decision?: Decision;
  /** The outcome: act, confirm, ask, wait or ignore. */
  outcome: Outcome;
  /** Time spent in code (normalise + policy), excluding the model round trip. */
  codeMs: number;
  /** Total time, model included. */
  totalMs: number;
}

/** Options for `understand()`. */
export interface UnderstandOptions {
  /** How the model's request is built. */
  request?: RequestOptions;
  /** What code can see beyond the words: places, skills, items, where the user is. */
  ctx?: SlotContext;
  /** Cancels a pending model request. */
  signal?: AbortSignal;
}

/**
 * Decides what a sentence means: normalise, find where it goes, code first, the model only when code can't, then the
 * policy's checks. It plans and runs nothing; `Actor.handle()` does that.
 * @param client Answers when code can't decide.
 * @param raw What was said.
 */
export async function understand(client: Decider, raw: string, opts: UnderstandOptions = {}): Promise<Understood> {
  const t0 = performance.now();
  const base = opts.ctx ?? NO_CONTEXT;
  const norm = normalise(raw, base.skills?.leadingWords());
  const scope = resolveScope(norm.text, base);
  const scoped: Normalised = scope.text === norm.text ? norm : { ...norm, text: scope.text, words: scope.text.split(" ").filter(Boolean) };
  // only the target app's items (the page in Brave, not the chat list in Telegram)
  const ctx = { ...base, target: scope.target, items: itemsFor(base.items, scope.target?.app, base.path), secrets: base.items?.filter(isPassword) };
  if (tracing()) {
    step("view", "pipeline.items", ctx.items ? `${ctx.items.length} items where the command goes` : "no items where the command goes", {
      target: scope.target?.app,
      items: ctx.items?.map((i) => `${i.role} "${i.label}"`) ?? [],
      passwordFieldsHidden: ctx.secrets?.length ?? 0,
    });
  }
  const early = decideWithoutModel(scoped, ctx);
  if (early) {
    const ms = performance.now() - t0;
    return { norm, scope, outcome: early, codeMs: ms, totalMs: ms };
  }
  const sk = base.skills ?? commonOnly();
  // the target's skills along the path, inner first: the model gets every one of their actions
  const skill = sk.along(targetPath({ ...ctx, target: scope.target })).map((s) => s.skill);
  // the item question only when the surface has items (a page, a chat list): labels are options, never state
  const items = ctx.items ? pickOptions(ctx.items, scope.text, base.excludeItems) : undefined;
  const request = { ...opts.request, operations: sk.modelOptions(skill), items };
  const req = buildRequest(scoped.text, request);
  if (tracing()) {
    step("build question", "pipeline.request", "code couldn't decide: the model gets the user's words and the options code wrote", {
      state: req.state,
      questions: Object.fromEntries(Object.entries(req.questions).map(([k, q]) => [k, { instructions: q.instructions, options: Object.keys(q.criteria ?? {}) }])),
    });
  }
  const t1 = performance.now();
  const decision = await client.decide(req, opts.signal);
  const t2 = performance.now();
  if (tracing()) {
    step("model", "pipeline.model", `${decision.model} answered in ${Math.round(decision.latencyMs)} ms`, {
      model: decision.model,
      answers: Object.fromEntries(
        Object.entries(decision.answers).map(([k, a]) => [k, a.type === "choice" ? { pick: a.choice, confidence: Math.round(a.confidence * 100) / 100, ranked: a.ranked.slice(0, 8).map((r) => ({ option: r.option, p: Math.round(r.p * 1000) / 1000 })) } : a]),
      ),
    });
  }
  const outcome = decide(scoped, decision.answers, ctx);
  const t3 = performance.now();
  return { norm, scope, decision, outcome, codeMs: t1 - t0 + (t3 - t2), totalMs: t3 - t0 };
}

/** Like `understand()`, with code only: what code alone decides, or undefined when it can't. */
export function understandByCode(raw: string, ctx: SlotContext = NO_CONTEXT): Understood | undefined {
  const t0 = performance.now();
  const norm = normalise(raw, ctx.skills?.leadingWords());
  const scope = resolveScope(norm.text, ctx);
  const scoped: Normalised = scope.text === norm.text ? norm : { ...norm, text: scope.text, words: scope.text.split(" ").filter(Boolean) };
  const outcome = decideWithoutModel(scoped, { ...ctx, target: scope.target, items: itemsFor(ctx.items, scope.target?.app, ctx.path), secrets: ctx.items?.filter(isPassword) });
  if (!outcome) return undefined;
  const ms = performance.now() - t0;
  return { norm, scope, outcome, codeMs: ms, totalMs: ms };
}
