/**
 * Checking skills that arrive as data: from a surface over a connection, from a file, or from a control panel.
 * Every problem is reported with where it is, and nothing is half-accepted.
 */
import { COMMON_OPERATIONS } from "../core/operations.ts";
import { SLOT_KINDS } from "./slotkinds.ts";
import { compileTemplate } from "./template.ts";
import type { Skill, SkillAction } from "./types.ts";

const RISKS = new Set(["safe", "fill", "confirm", "never"]);
const KINDS = new Set<string>(SLOT_KINDS);
const COMMON = new Set(COMMON_OPERATIONS.map((o) => o.id));
const ACTION_KEYS = new Set(["id", "label", "what", "risk", "templates", "anywhere", "ambient", "afterModel", "slots", "usesLastSearch", "nouns", "offer", "example", "does", "shows", "byLabel"]);
const SKILL_KEYS = new Set(["id", "places", "actions", "handles"]);
const GROUPS = ["templates", "anywhere", "ambient", "afterModel"] as const;
/** Limits, in line with the wire's: far above any real skill, low enough that a check stays cheap. */
export const SKILL_LIMITS = { skills: 100, actions: 200, places: 100, templates: 200, text: 300, nouns: 50 } as const;

/** Skills that aren't valid data. Its message says where the problem is: `skills[0] (notes).actions[2] (notes.delete): …`. */
export class SkillError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function checkAction(a: unknown, where: string, seen: Set<string>): asserts a is SkillAction {
  if (!isObj(a)) throw new SkillError(`${where}: an action must be an object`);
  for (const k of Object.keys(a)) if (!ACTION_KEYS.has(k)) throw new SkillError(`${where}: unknown field "${k}"`);
  if (!isStr(a.id)) throw new SkillError(`${where}: "id" must be a string`);
  const at = `${where} (${a.id})`;
  if (seen.has(a.id) || COMMON.has(a.id)) throw new SkillError(`${at}: id used twice or by a common operation`);
  seen.add(a.id);
  for (const k of ["label", "what"] as const) if (!isStr(a[k])) throw new SkillError(`${at}: "${k}" must be a string`);
  for (const k of ["label", "what", "example", "does"] as const) {
    if (typeof a[k] === "string" && a[k].length > SKILL_LIMITS.text) throw new SkillError(`${at}: "${k}" is longer than ${SKILL_LIMITS.text} characters`);
  }
  if (a.nouns !== undefined && (!Array.isArray(a.nouns) || a.nouns.length > SKILL_LIMITS.nouns || !a.nouns.every(isStr))) {
    throw new SkillError(`${at}: "nouns" must be a list of at most ${SKILL_LIMITS.nouns} words`);
  }
  if (!RISKS.has(a.risk as string)) throw new SkillError(`${at}: "risk" must be one of ${[...RISKS].join(", ")}`);
  if (a.offer !== undefined && a.offer !== "target" && a.offer !== "always") throw new SkillError(`${at}: "offer" must be "target" or "always"`);
  for (const k of ["example", "does"] as const) if (a[k] !== undefined && !isStr(a[k])) throw new SkillError(`${at}: "${k}" must be a string`);
  for (const k of ["usesLastSearch", "shows", "byLabel"] as const) if (a[k] !== undefined && typeof a[k] !== "boolean") throw new SkillError(`${at}: "${k}" must be true or false`);
  if (a.slots !== undefined) {
    if (!isObj(a.slots)) throw new SkillError(`${at}: "slots" must map slot names to kinds`);
    for (const [name, kind] of Object.entries(a.slots)) if (!KINDS.has(kind as string)) throw new SkillError(`${at}: slot "${name}" has unknown kind "${kind}"`);
  }
  if (!Array.isArray(a.templates)) throw new SkillError(`${at}: "templates" must be a list (it may be empty)`);
  let any = 0;
  const count = GROUPS.reduce((n, g) => n + (Array.isArray(a[g]) ? (a[g] as unknown[]).length : 0), 0);
  if (count > SKILL_LIMITS.templates) throw new SkillError(`${at}: more than ${SKILL_LIMITS.templates} templates`);
  for (const g of GROUPS) {
    const list = a[g];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new SkillError(`${at}: "${g}" must be a list`);
    for (const [i, spec] of list.entries()) {
      const source = typeof spec === "string" ? spec : isObj(spec) && isStr(spec.t) && isObj(spec.set) ? spec.t : undefined;
      if (!source) throw new SkillError(`${at}: ${g}[${i}] must be a template string or {t, set}`);
      if (source.length > SKILL_LIMITS.text) throw new SkillError(`${at}: ${g}[${i}] is longer than ${SKILL_LIMITS.text} characters`);
      try {
        compileTemplate(source);
      } catch (err) {
        throw new SkillError(`${at}: ${g}[${i}]: ${(err as Error).message}`);
      }
      any++;
    }
  }
  if (any === 0) throw new SkillError(`${at}: no templates at all, so nothing could ever ask for it`);
}

/**
 * Checks skills from untrusted data, such as a surface over a connection or a file, and returns them. Stops at the
 * first problem with a `SkillError`. Unknown fields are refused, and sizes are limited (`SKILL_LIMITS`).
 *
 * @example
 * const skills = parseSkills(JSON.parse(text), "my-app skills");
 */
export function parseSkills(data: unknown, source = "skills"): Skill[] {
  if (!Array.isArray(data)) throw new SkillError(`${source}: expected a list of skills`);
  if (data.length > SKILL_LIMITS.skills) throw new SkillError(`${source}: more than ${SKILL_LIMITS.skills} skills`);
  const ids = new Set<string>();
  const actionIds = new Set<string>();
  return data.map((s, i) => {
    const where = `${source}[${i}]`;
    if (!isObj(s)) throw new SkillError(`${where}: a skill must be an object`);
    if (!isStr(s.id)) throw new SkillError(`${where}: "id" must be a string`);
    for (const k of Object.keys(s)) if (!SKILL_KEYS.has(k)) throw new SkillError(`${where} (${s.id}): unknown field "${k}"`);
    if (ids.has(s.id)) throw new SkillError(`${where}: skill "${s.id}" twice`);
    ids.add(s.id);
    if (!Array.isArray(s.places) || s.places.length > SKILL_LIMITS.places || !s.places.every(isStr)) throw new SkillError(`${where} (${s.id}): "places" must be a list of at most ${SKILL_LIMITS.places} place names`);
    if (!Array.isArray(s.actions) || s.actions.length === 0 || s.actions.length > SKILL_LIMITS.actions) throw new SkillError(`${where} (${s.id}): "actions" must be a list of 1 to ${SKILL_LIMITS.actions} actions`);
    if (s.handles !== undefined && (!Array.isArray(s.handles) || !s.handles.every((h) => COMMON.has(h as string)))) {
      throw new SkillError(`${where} (${s.id}): "handles" must be a list of common operations`);
    }
    s.actions.forEach((a, j) => checkAction(a, `${where} (${s.id}).actions[${j}]`, actionIds));
    return s as unknown as Skill;
  });
}
