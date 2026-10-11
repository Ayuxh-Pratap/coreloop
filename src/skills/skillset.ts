/**
 * What the connected surface can do, compiled once: the common operations it declared it supports, and
 * its skills (plain data). The core has no skills of its own and never decides a common operation the surface
 * didn't declare.
 */
import { ALL_COMMON, COMMON_OPERATIONS, CONVERSATION, type Operation, type Risk } from "../core/operations.ts";
import type { Slots } from "../core/slots.ts";
import { resolveSlot } from "./slotkinds.ts";
import { currentProfile, type Profile } from "../profile/profile.ts";
import { compileTemplate, matchTemplate, templateTokens, type Template } from "./template.ts";
import type { CheckCtx, Skill, SkillAction, TemplateSpec } from "./types.ts";
import { step } from "../core/trace.ts";

export type { CheckCtx, Skill, SkillAction, TemplateSpec } from "./types.ts";

interface Compiled {
  template: Template;
  set: Partial<Slots>;
}

export interface SkillHit {
  action: SkillAction;
  slots: Slots;
  /** The template that matched, for the reason line. */
  template: string;
}

type Group = "templates" | "anywhere" | "ambient" | "afterModel";

const compile = (specs: readonly TemplateSpec[] = []): Compiled[] =>
  specs.map((s) => (typeof s === "string" ? { template: compileTemplate(s), set: {} } : { template: compileTemplate(s.t), set: s.set }));

const COMMON = new Map(COMMON_OPERATIONS.map((o) => [o.id, o]));
const APP_OPS = new Set(["open_app", "focus_app", "close_app"]);

/**
 * A surface's skills and common operations, ready to match: what `Actor` builds from a surface. Actions the profile
 * turned off are left out.
 */
export class SkillSet {
  /** The skills, minus actions turned off. */
  readonly skills: readonly Skill[];
  /** The common operations the surface supports, plus the conversation ones. */
  private readonly ops: ReadonlySet<string>;
  private readonly compiled = new Map<SkillAction, Record<Group, Compiled[]>>();
  private readonly byId = new Map<string, { skill: Skill; action: SkillAction }>();

  constructor(given: readonly Skill[] = [], declared: readonly string[] = ALL_COMMON, off: readonly string[] = currentProfile().off) {
    // what I turned off (profile/actions.json) is never decided and never offered
    const skills = off.length ? given.map((s) => ({ ...s, actions: s.actions.filter((a) => !off.includes(a.id)) })).filter((s) => s.actions.length) : given;
    const operations = declared.filter((o) => !off.includes(o));
    this.skills = skills;
    for (const op of operations) if (!COMMON.has(op)) throw new Error(`"${op}" is not a common operation`);
    this.ops = new Set([...operations, ...CONVERSATION]);
    for (const skill of skills) {
      for (const action of skill.actions) {
        if (this.byId.has(action.id) || COMMON.has(action.id)) throw new Error(`skill action "${action.id}" defined twice`);
        this.byId.set(action.id, { skill, action });
        this.compiled.set(action, {
          templates: compile(action.templates),
          anywhere: compile(action.anywhere),
          ambient: compile(action.ambient),
          afterModel: compile(action.afterModel),
        });
      }
    }
  }

  /** The surface supports this common operation (conversation operations always count). */
  supports(operation: string): boolean {
    return this.ops.has(operation);
  }

  /** The common operations the surface supports, as the model reads them (conversation ones last). */
  commonOperations(): Operation[] {
    return COMMON_OPERATIONS.filter((o) => this.ops.has(o.id));
  }

  /**
   * The skills for the places a command is for, innermost first, each with its place: a web app's skill for
   * localhost:3000, then the page's for Brave. For any one place only its first skill counts.
   */
  along(path: readonly string[]): { place: string; skill: Skill }[] {
    const out: { place: string; skill: Skill }[] = [];
    for (const place of [...path].reverse()) {
      const skill = this.skills.find((s) => s.places.includes(place));
      if (skill && !out.some((o) => o.skill === skill)) out.push({ place, skill });
    }
    return out;
  }

  /** The skill for a place. */
  forApp(app: string | undefined): Skill | undefined {
    return app ? this.skills.find((s) => s.places.includes(app)) : undefined;
  }

  /** An action by id, with its skill. */
  action(id: string): { skill: Skill; action: SkillAction } | undefined {
    return this.byId.get(id);
  }

  /** The risk of a supported common operation or of a skill action. */
  risk(operation: string): Risk | undefined {
    return (this.ops.has(operation) ? COMMON.get(operation)?.risk : undefined) ?? this.byId.get(operation)?.action.risk;
  }

  /**
   * The model's options, in a measured order: the app operations, then the actions offered everywhere, then the other
   * common operations, then the target's own actions, then confirm, cancel and none. Order matters to a small model.
   */
  modelOptions(target?: Skill | readonly Skill[]): Operation[] {
    const common = this.commonOperations();
    const asOption = (a: SkillAction): Operation => ({ id: a.id, what: a.what, risk: a.risk });
    const always = this.skills.flatMap((s) => s.actions.filter((a) => a.offer === "always"));
    const targets = target === undefined ? [] : Array.isArray(target) ? (target as readonly Skill[]) : [target as Skill];
    const forTarget = targets.flatMap((t) => t.actions).filter((a) => !always.includes(a));
    const appOps = common.filter((o) => APP_OPS.has(o.id));
    const otherOps = common.filter((o) => !APP_OPS.has(o.id) && !CONVERSATION.has(o.id));
    const conversation = common.filter((o) => CONVERSATION.has(o.id));
    return [...appOps, ...always.map(asOption), ...otherOps, ...forTarget.map(asOption), ...conversation];
  }

  private tryAction(action: SkillAction, group: Group, text: string, ctx: CheckCtx): SkillHit | undefined {
    for (const c of this.compiled.get(action)![group]) {
      const found = matchTemplate(c.template, text);
      if (!found) continue;
      const slots = this.fill(action, found, c.set, ctx);
      if (slots) return { action, slots, template: c.template.source };
      step("skills", "skills.kind-rejected", `"${c.template.source}" fits the sentence, but a slot's kind refused the words: the next sentence gets a chance`, { action: action.id, captured: found, kinds: action.slots ?? {} });
    }
    return undefined;
  }

  /** The captured words and the template's fixed values, through each slot's declared kind. */
  private fill(action: SkillAction, found: Record<string, string>, set: Partial<Slots>, ctx: CheckCtx): Slots | undefined {
    const slots: Record<string, unknown> = {};
    for (const [name, value] of Object.entries({ ...found, ...set })) {
      const kind = action.slots?.[name] ?? (name in found ? "words" : undefined);
      if (!kind) {
        slots[name] = value; // a fixed value from the template ("kind: track")
        continue;
      }
      const resolved = resolveSlot(kind, name, String(value), ctx, action.nouns);
      if (!resolved) return undefined;
      Object.assign(slots, resolved);
    }
    if (action.usesLastSearch) {
      if (!ctx.lastQuery) return undefined;
      slots.query = ctx.lastQuery;
    }
    return slots as Slots;
  }

  /** The first of a skill's actions whose template matches the whole sentence. */
  matchSkill(skill: Skill, text: string, ctx: CheckCtx, only?: (a: SkillAction) => boolean): SkillHit | undefined {
    for (const action of skill.actions) {
      if (only && !only(action)) continue;
      const hit = this.tryAction(action, "templates", text, ctx);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Templates that name their app themselves ("ask cursor to …") or need none ("maximize it"), tried with no target. */
  matchAnywhere(text: string, ctx: CheckCtx): (SkillHit & { app?: string }) | undefined {
    for (const skill of this.skills) {
      for (const action of skill.actions) {
        const hit = this.tryAction(action, "anywhere", text, ctx);
        if (hit) return { ...hit, app: skill.places[0] };
      }
    }
    return undefined;
  }

  /** Templates of an open app's skill that only that app can mean ("play any Panther song" while Spotify is open). */
  matchAmbient(text: string, open: readonly string[], ctx: CheckCtx): (SkillHit & { app: string }) | undefined {
    for (const skill of this.skills) {
      const app = skill.places.find((a) => open.includes(a));
      if (!app) continue;
      for (const action of skill.actions) {
        const hit = this.tryAction(action, "ambient", text, ctx);
        if (hit) return { ...hit, app };
      }
    }
    return undefined;
  }

  /** Slots for an action the model picked: any of its templates that fits the words, the loose ones last. */
  slots(actionId: string, text: string, ctx: CheckCtx): Slots | undefined {
    const entry = this.byId.get(actionId);
    if (!entry) return undefined;
    for (const group of ["templates", "anywhere", "ambient", "afterModel"] as const) {
      const hit = this.tryAction(entry.action, group, text, ctx);
      if (hit) return hit.slots;
    }
    return undefined;
  }

  /** Some sentence of this skill starts with the verb ("click" in "(click|press) [on] [the] {item}"). */
  startsWithVerb(skill: Skill | undefined, verb: string): boolean {
    if (!skill) return false;
    const first = verb.split(" ")[0]!;
    return skill.actions.some((a) =>
      [...a.templates, ...(a.anywhere ?? []), ...(a.ambient ?? [])].some((t) => firstWords(typeof t === "string" ? t : t.t).includes(first)),
    );
  }

  /**
   * The actions usable anywhere whose sentences start with the verb ("maximize it"): window actions from the desktop,
   * say, while the page in front has none.
   */
  verbActions(verb: string): string[] {
    const first = verb.split(" ")[0]!;
    return this.skills.flatMap((s) =>
      s.actions.filter((a) => [...(a.anywhere ?? []), ...(a.ambient ?? [])].some((t) => firstWords(typeof t === "string" ? t : t.t).includes(first))).map((a) => a.id),
    );
  }

  /** The words a sentence of any skill can start with ("split", "like", "click"), for telling a command from words. */
  leadingWords(): ReadonlySet<string> {
    if (!this.leading) {
      const all = this.skills.flatMap((s) =>
        s.actions.flatMap((a) => [...a.templates, ...(a.anywhere ?? []), ...(a.ambient ?? [])].flatMap((t) => firstWords(typeof t === "string" ? t : t.t))),
      );
      this.leading = new Set(all.filter((w) => w && !NOT_VERBS.has(w)));
    }
    return this.leading;
  }
  private leading: ReadonlySet<string> | undefined;

  /** "play something on Spotify, search in Spotify, …" */
  canDo(skill: Skill): string {
    return skill.actions.map((a) => a.label).join(", ");
  }

  /** "open, switch to or close an app, play/pause/next/volume, …": the supported common operations in words. */
  basics(): string {
    const can = (id: string) => (this.ops.has(id) ? COMMON.get(id)!.can! : undefined);
    const apps = ["open_app", "focus_app", "close_app"].map(can).filter(Boolean) as string[];
    const words = ["paste_text", "type_text"].map(can).filter(Boolean) as string[];
    const parts = [
      apps.length ? `${apps.length > 1 ? `${apps.slice(0, -1).join(", ")} or ${apps.at(-1)}` : apps[0]} an app` : undefined,
      can("media"),
      can("search_web"),
      can("open_url"),
      words.length ? `${words.join(" or ")} your words` : undefined,
      can("press_key"),
    ].filter(Boolean);
    return parts.join(", ");
  }
}

/** The words a template can start with: "(click|press) [on] {item}" → click, press; "[go] back" → go, back. */
/** Optional words a template may start with that never begin a command on their own ("[the] next tab"). */
const NOT_VERBS = new Set(["a", "an", "the", "my", "this", "that", "it", "some", "any", "all", "what", "what's", "whats", "is", "on", "in", "to", "for", "and", "can", "could", "we", "i", "you", "let's", "lets", "please", "up", "back", "full", "last", "page", "un"]);

function firstWords(source: string): string[] {
  const out: string[] = [];
  for (const t of templateTokens(source)) {
    if (t.startsWith("{") || t === "*") break;
    const inner = t.startsWith("(") || t.startsWith("[") ? t.slice(1, -1) : t;
    out.push(...inner.split("|").map((alt) => alt.trim().split(" ")[0]!));
    if (!t.startsWith("[")) break;
  }
  return out;
}

let common: { from: Profile; set: SkillSet } | undefined;
/** Every common operation and no skills: the default when no surface says otherwise. */
export function commonOnly(): SkillSet {
  const p = currentProfile();
  if (common?.from !== p) common = { from: p, set: new SkillSet([], ALL_COMMON, p.off) };
  return common.set;
}
