/**
 * Policy: model answers + code checks → one outcome per utterance.
 *
 *   act      do it now
 *   confirm  destructive: say what would happen and wait for a spoken "confirm"
 *   ask      unsure between options: show the top candidates, the user says which
 *   wait     the user hasn't finished ("open the …")
 *   ignore   not meant for the computer
 *
 * Code checks run first and win over the model where code is certain: an unfinished-sounding ending never
 * acts, and a close/quit/kill/exit verb is always a destructive close that needs confirming.
 *
 * Context: when a command is for an app with a skill (named, in front, or just opened), that skill's
 * templates are tried right after the app verbs, and the model also gets that skill's actions to pick from. A
 * named app with no matching action never falls through to a global action that would act elsewhere:
 * "search for X on Notion" must not become a web search.
 *
 * Every question is answerable: it lists only choices that can actually run, so "yes" or "two" does it,
 * and when there is nothing to choose it says what to say instead.
 *
 * Only what the surface supports: a common operation it didn't declare is never decided, by code or by the
 * model (the model isn't even offered it).
 */
import type { Answer, ChoiceAnswer } from "../backends/systemone.ts";
import { commonOnly, type CheckCtx, type SkillAction, type SkillSet } from "../skills/skillset.ts";
import { CONVERSATION } from "./operations.ts";
import { step } from "./trace.ts";
import type { Normalised } from "./normalise.ts";
import { splitCompound } from "./compound.ts";
import { matchGrammar } from "./grammar.ts";
import { parseUrl } from "./parse.ts";
import { findAppInText, nameApp, resolveApp, targetPhrase, TO_FRONT } from "./apps.ts";
import { missingSlots, NO_CONTEXT, resolveSlots, submitPhrase, type SlotContext, type Slots } from "./slots.ts";
import { endsDangling } from "./spans.ts";
import { endsWithLabel, ITEM_THRESHOLDS, looksDestructive, matchItem, saysLabel } from "./items.ts";

/** The policy's thresholds for the model's pick. Changing them is an engine change, made with an eval run. */
export const THRESHOLDS = {
  /** The lowest confidence an operation pick can have and still be used. */
  pick: 0.2,
  /** The smallest gap between the top two operation probabilities. */
  margin: 0.1,
  /** A lower-ranked operation can stand in for one code can't carry out only if the model gave it at least this. */
  fallback: 0.15,
  /** A surface's action picked with no template that fits is offered as a yes/no question only from this probability. */
  offer: 0.6,
} as const;

/** An answer to a question: an action that can run as it stands. */
export interface Choice {
  /** The operation it would run. */
  operation: string;
  /** Its details, all from the user's words. */
  slots: Slots;
  /** How the question names it: "next track", "open Claude". */
  label: string;
  /** Picking it still waits for a spoken "confirm" (it was offered for a close verb). */
  confirm?: boolean;
}

/**
 * How a sentence ends: `act` (it runs), `confirm` (held for a spoken "confirm"), `ask` (a question, with choices or a
 * hint), `wait` (half a sentence) or `ignore`. Every outcome has a `reason`, starting with `code:` or `model:`.
 */
export type Outcome =
  | { decision: "act" | "confirm"; operation: string; slots: Slots; reason: string; /** set when a spoken "confirm" released a pending action */ confirmed?: boolean }
  | {
      decision: "ask";
      options: { operation: string; p: number }[];
      reason: string;
      /** two commands in one sentence */
      parts?: string[];
      /** what "yes" / "one" / "two" would run */
      choices?: Choice[];
      /** what to say instead, when there is nothing to choose: "In Spotify I can: …", "say 'next song'" */
      hint?: string;
    }
  | { decision: "wait"; reason: string }
  | { decision: "ignore"; reason: string };

const DESTRUCTIVE_VERB = /^(?:close|quit|kill|exit|shut(?: down)?|terminate|end) \S/;
const closeVerb = (text: string) => DESTRUCTIVE_VERB.test(text);

/**
 * A sentence that starts with a close verb never acts without a spoken "confirm", whatever action it was decided
 * as: an act becomes a confirm, and every choice in a question is marked so that answering it confirms first.
 * The conversation's own operations (confirm, cancel, choose) are left alone.
 */
function mustConfirm(out: Outcome, norm: Normalised): Outcome {
  const why = `"${norm.words[0]}" is a close verb`;
  if (out.decision === "act" && !CONVERSATION.has(out.operation)) {
    step("outcome", "policy.close-confirm", `${why}: whatever it does waits for a spoken "confirm"`, { operation: out.operation });
    return { decision: "confirm", operation: out.operation, slots: out.slots, reason: `${out.reason}; ${why}` };
  }
  if (out.decision === "ask" && out.choices) return { ...out, choices: out.choices.map((c) => ({ ...c, confirm: true })) };
  return out;
}

function choice(answers: Record<string, Answer>, id: string): ChoiceAnswer | undefined {
  const a = answers[id];
  return a?.type === "choice" ? a : undefined;
}

function finish(operation: string, slots: Slots, reason: string, sk: SkillSet): Outcome {
  const risk = sk.risk(operation);
  const out = ((): Outcome => {
    if (risk === "never") return { decision: "ignore", reason: `${operation} is not voice-accessible` };
    // "… and send": pressing Enter sends, so it waits for a spoken confirm like any other send. So does acting on
    // an item whose label says buy / delete / send / submit…, whatever the action's own risk.
    if (risk === "confirm" || slots.submit) return { decision: "confirm", operation, slots, reason };
    if (typeof slots.item_label === "string" && looksDestructive(slots.item_label) && risk !== "fill") {
      return { decision: "confirm", operation, slots, reason: `${reason}; "${slots.item_label}" looks destructive` };
    }
    return { decision: "act", operation, slots, reason };
  })();
  step("outcome", "policy.finish", `${operation} has risk "${risk}": ${out.decision}`, { operation, risk, slots, decision: out.decision });
  return out;
}

/** A rule decided: record which (for the trace) and return its outcome. */
function ruled<T extends Outcome | undefined>(stage: string, id: string, note: string, out: T, data?: Record<string, unknown>): T {
  step(stage, id, note, { ...data, ...(out ? { decision: out.decision } : {}) });
  return out;
}

/**
 * Code-only decisions, checked before the model is called: empty input, an unfinished ending, app verbs, the
 * target app's templates, and closed phrasings from the grammar. Returns undefined when the model is needed.
 */
export function decideWithoutModel(norm: Normalised, ctx: SlotContext = NO_CONTEXT): Outcome | undefined {
  const out = byCode(norm, ctx);
  return out && closeVerb(norm.text) ? mustConfirm(out, norm) : out;
}

function byCode(norm: Normalised, ctx: SlotContext): Outcome | undefined {
  const text = norm.text;
  const sk = ctx.skills ?? commonOnly();
  if (!text) return ruled("code first", "policy.empty", "nothing was said", { decision: "ignore", reason: "nothing said" });
  // "click log in" ends on "in" but is finished when "Log in" is on the screen
  if (endsDangling(text) && !endsWithLabel(text, ctx.items)) {
    return ruled("code first", "policy.dangling", `ends on "${norm.words.at(-1)}": the user hasn't finished`, { decision: "wait", reason: `ends on "${norm.words.at(-1)}"` });
  }

  // Two commands in one sentence: ask, so the first half never runs while the second is silently dropped.
  const parts = splitCompound(text, sk.leadingWords());
  if (parts) {
    return ruled("code first", "policy.compound", `${parts.length} commands in one sentence`, { decision: "ask", options: [], parts, reason: `${parts.length} commands in one sentence` }, { parts });
  }

  // "<verb> <installed app>" has one reading: a launch/switch verb shows the app, a close verb closes it
  // (and still needs a spoken confirm). Only when the app list gives a clear match; otherwise the model decides.
  const verb = TO_FRONT.test(text) ? "bring … to the front" : APP_VERB.exec(text)?.[1];
  const appOp = verb ? (DESTRUCTIVE_VERB.test(text) ? "close_app" : FOCUS_VERB.test(verb) ? "focus_app" : "open_app") : undefined;
  if (verb && appOp && sk.supports(appOp)) {
    const operation = appOp;
    const slots = resolveSlots(operation, text, ctx);
    // "open settings" on a page with a Settings link, and a Settings app installed: ask which. A page of the app
    // I'm in (a place of another kind than "app") and its own link to it are one thing: no question.
    const kind = ctx.apps.find((a) => a.name === slots.app)?.kind ?? "app";
    const onScreen = operation === "open_app" && slots.app && kind === "app" ? labelInUse(targetPhrase(text), ctx) : undefined;
    if (onScreen) {
      return ruled("code first", "policy.app-or-label", `"${slots.app}" is a place and a label on the screen: ask which`, {
        decision: "ask",
        options: [],
        reason: `"${slots.app}" is an app and "${onScreen.slots.item_label}" is on the screen`,
        choices: [onScreen, { operation, slots, label: `open the ${slots.app} app` }],
      });
    }
    if (slots.app || slots.window) {
      step("code first", "policy.app-verb", `"${verb}" + a place code knows: ${operation}`, { verb, slots });
      return finish(operation, slots, `code: "${verb}" + ${slots.app ? `installed app "${slots.app}"` : "this window"}`, sk);
    }
    step("code first", "policy.app-verb-no-place", `"${verb}", but the words name no place code knows: on to the next rule`, { verb });
  }

  // Never typed into a password field: "type hunter2 into the password" is refused, not typed wherever the
  // focus is. A field named like one, or a password field on the screen named by its label.
  const into = DICTATE_INTO.exec(text)?.[1];
  if (into && (SECRET_WORDS.test(into) || saysLabel(into, ctx.secrets ?? []))) {
    return ruled("code first", "policy.password", `"${into}" is a password field: never typed into`, { decision: "ask", options: [], reason: `"${into}" is a password field`, hint: "I never type into password fields. Type it yourself." });
  }

  // "type git status in the terminal": dictation into a named app. Decided here, because the model, offered that
  // app's actions, picks one of them instead ("new tab").
  const typing = TYPE_INTO.exec(text)?.[1];
  const typeOp = typing === "paste" ? "paste_text" : "type_text";
  if (typing && ctx.target?.via === "named" && sk.supports(typeOp)) {
    const slots = resolveSlots(typeOp, text, ctx);
    if (slots.span) {
      step("code first", "policy.type-into", `dictation into ${ctx.target.app}, which was named`, { span: slots.span });
      return finish(typeOp, slots, `code: ${typing} into ${ctx.target.app}`, sk);
    }
  }

  // The target app's own actions.
  const check = checkCtx(ctx);
  const target = ctx.target;
  // Along the path, inner first: my web app's route, then the page, then the browser it's in.
  // A fixed sentence anywhere on the path beats "click whatever has these words": "open a new tab" is the browser's,
  // not my app's "open {item}" on its "New project" button.
  // "… and send": only the common typing operations can submit. A skill's sentence would take those words into a
  // slot and drop them, so skills see the sentence without them, and one that fits is asked about, never run.
  const submit = submitPhrase(text);
  const words = submit ? text.slice(0, -(submit.length + 1)) : text;
  const cantSubmit = (action: SkillAction) =>
    ruled("skills", "policy.no-submit", `${action.id} can't "${submit}": ask, don't drop the words`, {
      decision: "ask",
      options: [],
      reason: `${action.id} can't "${submit}"`,
      hint: `I can ${action.label}, but I can't "${submit}" here. Say it without "${submit}".`,
    });
  const along = sk.along(targetPath(ctx));
  step("skills", "policy.along", along.length ? "the skills where the command goes, inner first" : "no skill where the command goes", { path: targetPath(ctx), skills: along.map((a) => `${a.skill.id} (${a.place})`) });
  for (const pass of [(a: SkillAction) => !takesItem(a), takesItem]) {
    for (const { place, skill } of along) {
      const hit = sk.matchSkill(skill, words, check, pass);
      if (hit && submit) return cantSubmit(hit.action);
      if (hit) {
        step("skills", "policy.skill", `${skill.id}'s sentence "${hit.template}" matches`, { action: hit.action.id, place, slots: hit.slots, pass: pass === takesItem ? "item sentences" : "fixed sentences" });
        return finish(hit.action.id, { ...hit.slots, app: place }, `code: ${skill.id} "${hit.template}" (${place}, ${target!.via})`, sk);
      }
    }
  }
  // Templates that name their own app ("ask cursor to …") or need none ("maximize it").
  const anywhere = sk.matchAnywhere(words, check);
  if (anywhere && submit) return cantSubmit(anywhere.action);
  if (anywhere) {
    step("skills", "policy.anywhere", `"${anywhere.template}" names its own place, or needs none`, { action: anywhere.action.id, slots: anywhere.slots });
    return finish(anywhere.action.id, anywhere.app ? { ...anywhere.slots, app: anywhere.app } : anywhere.slots, `code: "${anywhere.template}"`, sk);
  }
  // Words only an open app can mean ("play any Panther song" while Spotify runs behind the browser).
  const ambient = ctx.open ? sk.matchAmbient(words, ctx.open, check) : undefined;
  if (ambient && submit) return cantSubmit(ambient.action);
  if (ambient) {
    step("skills", "policy.ambient", `${ambient.app} is open and only it can mean "${ambient.template}"`, { action: ambient.action.id, slots: ambient.slots });
    return finish(ambient.action.id, { ...ambient.slots, app: ambient.app }, `code: ${ambient.app} is open, "${ambient.template}"`, sk);
  }
  // "type rahul@example.com into the email" with no field or app of that name here: say so, instead of typing the
  // whole sentence wherever the focus is. Only "into": "type see you in the morning" is all words.
  const dest = INTO_WHAT.exec(text)?.[1];
  if (dest && !nameApp(dest, ctx.apps) && !matchItem(dest, ctx.items ?? [])) {
    return ruled("code first", "policy.into-nothing", `nothing here is called "${dest}": ask, don't type the sentence`, { decision: "ask", options: [], reason: `nothing here is called "${dest}"`, hint: `I don't see "${dest}" here. ${whatICanDo(ctx)}` });
  }
  // "play the first song" with no list to point into: say so, instead of letting the model press play. Only when
  // nothing is on the screen; with items, the position is theirs to settle.
  if (POSITIONAL.test(text) && !ctx.items?.length) {
    return ruled("code first", "policy.no-list", "a position in a list, but there is no list", { decision: "ask", options: [], reason: "a position in a list, but there is no list", hint: `I don't know which list you mean. Search for something first, then say which one ("the first one").` });
  }

  const hit = matchGrammar(text);
  if (hit && sk.supports(hit.operation)) {
    const slots = resolveSlots(hit.operation, text, ctx);
    // shape matched but details don't resolve: let the model look
    if (!missingSlots(hit.operation, slots).length) {
      step("code first", "policy.grammar", `a closed phrasing: ${hit.rule}`, { operation: hit.operation, slots });
      return notHere(hit.operation, ctx) ?? finish(hit.operation, inNamedApp(hit.operation, slots, ctx), `code: ${hit.rule}`, sk);
    }
    return ruled("code first", "policy.grammar-incomplete", `looks like ${hit.operation}, but a detail is missing: the model looks`, undefined, { rule: hit.rule, missing: missingSlots(hit.operation, slots) });
  }

  // a button or link named on its own ("save changes", "new issue")
  const labelled = labelInUse(text, ctx);
  if (labelled) {
    step("code first", "policy.label", `"${String(labelled.slots.item_label)}" is said on its own and is on the screen`, { operation: labelled.operation });
    return finish(labelled.operation, labelled.slots, `code: "${labelled.slots.item_label}" is on the screen`, sk);
  }
  return ruled("code first", "policy.to-model", "no rule decided: the model is asked", undefined, {
    tried: ["empty", "unfinished", "two commands", "verb + place", "password field", "typing into a named place", "skills along the path", "sentences that name their place", "words only an open place means", "into what?", "a position with no list", "closed phrasings", "a label said alone"],
  });
}

/**
 * The places a command is for, outermost first (contract v2): the path up to the target when the target is on it
 * ("Brave" › "localhost:3000" › "Pricing" for the route in front), else the target alone (a place that was named).
 */
export function targetPath(ctx: SlotContext): string[] {
  const t = ctx.target;
  if (!t) return [];
  const p = ctx.path ?? [];
  const i = p.lastIndexOf(t.app);
  return i >= 0 ? p.slice(0, i + 1) : [t.app];
}

/** Which of a skill's places an action of it acts in: the innermost one on the target's path, else its first. */
function placeFor(places: readonly string[], ctx: SlotContext): string | undefined {
  return [...targetPath(ctx)].reverse().find((p) => places.includes(p)) ?? places[0];
}

/** The target app's "say the label" action on the item whose label is what was said, as a choice. */
function labelInUse(phrase: string | undefined, ctx: SlotContext): Choice | undefined {
  const sk = ctx.skills ?? commonOnly();
  const target = ctx.target;
  const found = sk.along(targetPath(ctx)).flatMap(({ place, skill }) => skill.actions.filter((a) => a.byLabel).map((action) => ({ place, action })))[0];
  if (!phrase || !target || !found || !ctx.items?.length) return undefined;
  const { place, action } = found;
  const item = saysLabel(phrase, ctx.items);
  const slot = Object.entries(action.slots ?? {}).find(([, k]) => k === "item")?.[0];
  if (!item || !slot) return undefined;
  return { operation: action.id, slots: { [slot]: item.id, [`${slot}_label`]: item.label, app: place }, label: `${action.label}: ${item.label}` };
}

/** "play the first song", "play song number two": a position in a list. */
const POSITIONAL = /^play (?:the )?(?:first|second|third|fourth|fifth|top|last|1st|2nd|3rd|[45]th) (?:song|track|result|one|video|item)\b|^play (?:song|track|result) (?:number )?(?:one|two|three|four|five|\d)\b/;

const TYPE_INTO = /^(type|write|paste) /;

/** "type X into the Y": where dictated words would go. */
const DICTATE_INTO = /^(?:type|paste|enter|write|put|fill in|input) .+ (?:into|in|on) (?:the |my |this )?(.+)$/;
/** "type X into the Y": the Y, which must be something that's there. */
const INTO_WHAT = /^(?:type|paste|enter|write|put|fill in|input) .+ into (?:the |my |this )?(.+?)(?: (?:field|box|input))?$/;
/** Fields that hold secrets, whatever the surface calls them. */
const SECRET_WORDS = /\b(?:password|passcode|passphrase|pin|secret|one time code|2fa code)\b/;

/** An action that acts on one of the surface's items ("click {item}"). */
const takesItem = (a: SkillAction): boolean => Object.values(a.slots ?? {}).includes("item");

/**
 * Action verbs (English, not any surface's): one is refused as "not yet" when nothing that can be decided here starts
 * with it. Without this the model maps it onto the nearest action that exists: on day 2 "minimize Spotify"
 * became a close and "maximize it" became typing.
 */
const ACTION_VERBS = /^(?:minimi[sz]e|maximi[sz]e|expand|restore|resize|snap|send|submit|post|delete|remove|erase|clear|click|double click|right click|tap|scroll|select|highlight|copy|cut|undo|redo|save|rename|drag|zoom|reply|forward|share|download|upload|install|uninstall|pin|unpin|archive|block)\b/;

const APP_VERB = /^(open|launch|start|run|fire up|boot up|load|bring up|bring back|switch to|switch back to|go back to|jump to|take me to|navigate to|head to|show me|focus(?: on)?|close|quit|kill|exit|shut down|terminate) /;
const FOCUS_VERB = /^(?:bring|switch|go back|jump|show|focus)/;

/** Operations that look different to the user but run the same action. */
const APP_OPS = new Set(["open_app", "focus_app"]);
/** A domain the user spelled out ("github dot com", "example.com"), as opposed to a bare site name. */
const EXPLICIT_DOMAIN = /(?:dot (?:com|org|net|io|dev|ai|app|co|in)|[a-z0-9-]+\.[a-z]{2,})|local ?host/;

/** Global actions that are fine whichever app was named: they act on that app (typing goes into it), or on none. */
const ANY_APP = new Set(["media", "open_app", "focus_app", "close_app", "type_text", "paste_text", "confirm", "cancel", "choose", "none"]);

/**
 * "search for X on Notion" with no Notion skill: a web search would do something other than what was asked. Say
 * what the named app can do instead.
 */
function notHere(operation: string, ctx: SlotContext): Outcome | undefined {
  const target = ctx.target;
  const sk = ctx.skills ?? commonOnly();
  if (target?.via !== "named" || ANY_APP.has(operation) || sk.action(operation)) return undefined;
  // the named app's own surface carries it out there ("search for X on Brave" searches in its page)
  if (sk.forApp(target.app)?.handles?.includes(operation)) return undefined;
  const skill = sk.forApp(target.app);
  return {
    decision: "ask",
    options: [],
    reason: `${operation} would act outside ${target.app}, which was named`,
    hint: skill ? `In ${target.app} I can: ${sk.canDo(skill)}.` : noActions(target.app, sk),
  };
}

/** "Notepad has no actions of its own yet: I can open it or switch to it", from what the surface supports. */
function noActions(app: string, sk: SkillSet): string {
  const can = [
    ["open_app", "open it"],
    ["focus_app", "switch to it"],
    ["close_app", "close it"],
  ].flatMap(([op, words]) => (sk.supports(op!) ? [words!] : []));
  const list = can.length > 1 ? `${can.slice(0, -1).join(", ")} or ${can.at(-1)}` : can[0];
  return list ? `${app} has no actions of its own yet: I can ${list}.` : `I can't do anything in ${app} yet.`;
}

/** A common operation for a named app that handles it carries that app, so it happens there. */
function inNamedApp(operation: string, slots: Slots, ctx: SlotContext): Slots {
  const target = ctx.target;
  const sk = ctx.skills ?? commonOnly();
  return target?.via === "named" && !slots.app && sk.forApp(target.app)?.handles?.includes(operation) ? { ...slots, app: target.app } : slots;
}

/** How to say each global action, for replies. The app ones name an app the surface reports. */
const EXAMPLES: Readonly<Record<string, string>> = {
  paste_text: '"paste hello world"',
  type_text: '"type hello world"',
  press_key: '"press enter"',
  media: '"pause" or "volume up"',
  open_url: '"go to example dot com"',
  search_web: '"search for the weather"',
};
const APP_VERBS: Readonly<Record<string, string>> = { open_app: "open", focus_app: "switch to", close_app: "close" };

function example(operation: string, ctx: SlotContext): string | undefined {
  const verb = APP_VERBS[operation];
  if (!verb) return EXAMPLES[operation];
  const app = ctx.open?.[0] ?? ctx.apps[0]?.name;
  return app ? `"${verb} ${app}"` : `"${verb}" and the app's name`;
}

/** What a missing slot means in words. */
const MISSING: Readonly<Record<string, string>> = {
  app: "which app",
  span: "the words",
  key: "which key",
  media: "whether to play, pause, skip or change the volume",
  url: "which site",
  query: "what to look for",
};

const MEDIA_LABELS: Readonly<Record<string, string>> = {
  play_pause: "play/pause",
  next: "next track",
  previous: "previous track",
  volume_up: "volume up",
  volume_down: "volume down",
  mute: "mute",
};

/** A choice in words: "open Claude", "next track", "search in Spotify for "panther"". */
export function choiceLabel(operation: string, slots: Slots, sk: SkillSet = commonOnly()): string {
  const skill = sk.action(operation);
  if (skill) return skill.action.label + (slots.query ? ` for "${slots.query}"` : "");
  switch (operation) {
    case "open_app":
      return `open ${slots.app}`;
    case "focus_app":
      return `switch to ${slots.app}`;
    case "close_app":
      return `close ${slots.app ?? "this window"}`;
    case "media":
      return MEDIA_LABELS[slots.media!] ?? "media";
    case "press_key":
      return `press ${slots.key}`;
    case "open_url":
      return `open ${slots.url}`;
    case "search_web":
      return `search the web for "${slots.span}"`;
    case "paste_text":
      return `paste "${slots.span}"`;
    case "type_text":
      return `type "${slots.span}"`;
    default:
      return operation.replace(/_/g, " ");
  }
}

/** What turning words into slots may look at. */
function checkCtx(ctx: SlotContext): CheckCtx {
  return { apps: ctx.apps, lastQuery: ctx.lastQuery, items: ctx.items, excludeItems: ctx.excludeItems, itemAnswer: ctx.itemAnswer, forceItem: ctx.forceItem };
}

/** Slots for any operation, global or a skill's; undefined when they can't be found in the words. */
function slotsFor(operation: string, text: string, ctx: SlotContext): Slots | undefined {
  const sk = ctx.skills ?? commonOnly();
  const entry = sk.action(operation);
  if (entry) {
    const s = sk.slots(operation, text, checkCtx(ctx));
    const app = placeFor(entry.skill.places, ctx);
    return s && (app ? { ...s, app } : s);
  }
  if (!sk.supports(operation)) return undefined;
  const s = resolveSlots(operation, text, ctx);
  return missingSlots(operation, s).length ? undefined : s;
}

/** The reply when the action is clear but a detail isn't in the words. */
function missingHint(operation: string, missing: string[], text: string, ctx: SlotContext): string {
  const sk = ctx.skills ?? commonOnly();
  if (missing.includes("app") && APP_VERBS[operation]) {
    const phrase = targetPhrase(text);
    return phrase ? `No app here is called "${phrase}". Say "no, I meant" and the app's name.` : `Which app? Say for example ${example(operation, ctx)}.`;
  }
  const said = sk.action(operation)?.action.example ?? example(operation, ctx);
  return `I couldn't tell ${missing.map((m) => MISSING[m] ?? m).join(" or ") || "what to do"}${said ? `. Say for example ${said}` : ""}.`;
}

/** What can be said where the command goes, in words: "In Spotify I can: …", then what works anywhere. */
export function whatICanDo(ctx: SlotContext): string {
  const sk = ctx.skills ?? commonOnly();
  const here = sk.along(targetPath(ctx))[0];
  const basics = sk.basics();
  if (here) return `In ${here.place} I can: ${sk.canDo(here.skill)}.${basics ? ` Anywhere: ${basics}.` : ""}`;
  return basics ? `I can ${basics}.` : "I can't do anything here yet.";
}

export function decide(norm: Normalised, answers: Record<string, Answer>, given: SlotContext = NO_CONTEXT): Outcome {
  // the model's pick among the surface's items, when it was asked
  const ctx: SlotContext = { ...given, itemAnswer: choice(answers, "item") };
  const early = decideWithoutModel(norm, ctx);
  if (early) return early;
  const out = byModel(norm, answers, ctx);
  return closeVerb(norm.text) ? mustConfirm(out, norm) : out;
}

function byModel(norm: Normalised, answers: Record<string, Answer>, ctx: SlotContext): Outcome {
  const text = norm.text;
  const sk = ctx.skills ?? commonOnly();

  const op = choice(answers, "operation");

  // An action verb is "not yet" unless the target app's own skill has sentences that start this way ("click …" on a
  // page), or an action any app can use does and the model picked it ("minimize" from the desktop).
  const notYet = ACTION_VERBS.exec(text)?.[0];
  if (notYet && !sk.along(targetPath(ctx)).some(({ skill }) => sk.startsWithVerb(skill, notYet)) && !(op && sk.verbActions(notYet).includes(op.choice))) {
    return ruled("policy", "policy.not-yet", `nothing here starts with "${notYet}": say so, never the nearest wrong action`, { decision: "ask", options: [], reason: `"${notYet}" isn't something I can do yet`, hint: `I can't ${notYet} that yet. ${whatICanDo(ctx)}` }, { verb: notYet, modelSaid: op?.choice });
  }
  // No model (none running, or it didn't answer in time): what code couldn't settle gets a question, never a guess.
  if (!op) return ruled("policy", "policy.no-model", "no model answered: ask, never guess", { decision: "ask", options: [], reason: "no model: code alone couldn't decide", hint: `I'm not sure what you meant, and the model isn't running. ${whatICanDo(ctx)}` });
  let operation = op.choice;
  let reason = `model: ${operation} ${(op.ranked[0]!.p * 100).toFixed(0)}%`;
  step("policy", "policy.model-pick", `the model picked ${operation}`, { pick: operation, confidence: Math.round(op.confidence * 100) / 100, top: op.ranked.slice(0, 3).map((r) => `${r.option} ${Math.round(r.p * 100)}%`) });
  // never an operation this surface didn't declare, even if the model names one it wasn't offered
  if (!sk.supports(operation) && !sk.action(operation)) {
    return ruled("policy", "policy.not-declared", `${operation} isn't something this surface does: refused`, { decision: "ask", options: [], reason: `${operation} isn't something this surface does`, hint: whatICanDo(ctx) });
  }

  // A close verb that names an app or this window closes it. Any other close verb ("exit fullscreen", "end the
  // call") goes on with the model's pick, and `decide` turns whatever it ends in into a confirm.
  if (closeVerb(text) && sk.supports("close_app")) {
    const slots = resolveSlots("close_app", text, ctx);
    if (!missingSlots("close_app", slots).length) {
      if (operation !== "close_app") reason = `code: "${norm.words[0]}" + ${slots.app ? `"${slots.app}"` : "this window"} is a close (model said ${operation})`;
      step("policy", "policy.close-verb", `"${norm.words[0]}" names ${slots.app ?? "this window"}: a close, whatever the model said`, { modelSaid: operation, slots });
      return finish("close_app", slots, reason, sk);
    }
  }

  if (choice(answers, "is_command")?.choice === "not_command") return ruled("policy", "policy.not-command", "the model's gate: not a command", { decision: "ignore", reason: "model: not a command" });
  if (operation === "none") return ruled("policy", "policy.none", "the model picked none: not a command (chit-chat, thinking aloud)", { decision: "ignore", reason: "model: not a command" });
  if (choice(answers, "complete")?.choice === "unfinished") return ruled("policy", "policy.unfinished", "the model heard an unfinished instruction: wait", { decision: "wait", reason: "model: unfinished" });

  // An installed app named in the words is decisive evidence the model can't see (it never gets the app list).
  const appHit = resolveApp(targetPhrase(text), ctx.apps) ?? findAppInText(text, ctx.apps);
  const [first, second] = op.ranked;
  const top3 = op.ranked.slice(0, 3).map((r) => r.option);
  const margin = first!.p - (second?.p ?? 0);
  const unsure = op.confidence < THRESHOLDS.pick || margin < THRESHOLDS.margin;
  step("policy", "policy.sure", unsure ? "the model is unsure" : "the model is sure enough", {
    confidence: Math.round(op.confidence * 100) / 100,
    needs: THRESHOLDS.pick,
    margin: Math.round(margin * 100) / 100,
    needsMargin: THRESHOLDS.margin,
    placeInWords: appHit?.app.name,
  });

  if (new Set([first!.option, second?.option]).has("open_app") && new Set([first!.option, second?.option]).has("open_url")) {
    // open_app vs open_url: a spelled-out domain is a URL; else an installed app; else a known site name; else an app.
    const url = parseUrl(text);
    const picked = url && EXPLICIT_DOMAIN.test(text) ? "open_url" : appHit ? "open_app" : url ? "open_url" : "open_app";
    if (picked !== operation || margin < THRESHOLDS.margin) {
      const why = picked === "open_url" ? `"${url}" is a site` : appHit ? `"${appHit.app.name}" is installed` : "no site named";
      reason = `code: ${why} → ${picked} (model: open_app ${pctOf(op, "open_app")}, open_url ${pctOf(op, "open_url")})`;
    }
    step("policy", "policy.app-or-url", `open an app or a site? code settles it: ${picked}`, { url, place: appHit?.app.name, modelSaid: operation, picked });
    operation = picked;
  } else if (unsure) {
    const appOp = appHit ? top3.find((o) => APP_OPS.has(o)) : undefined;
    if (!appOp) {
      const choices = op.ranked
        .slice(0, 3)
        .filter((r) => r.option !== "none" && r.option !== "confirm" && r.option !== "cancel")
        .flatMap((r) => {
          const slots = slotsFor(r.option, text, ctx);
          return slots && !notHere(r.option, ctx) ? [{ operation: r.option, slots, label: choiceLabel(r.option, slots, sk) }] : [];
        });
      return ruled("policy", "policy.unsure", "unsure: ask, offering only choices that can run", {
        decision: "ask",
        options: op.ranked.slice(0, 3).map((r) => ({ operation: r.option, p: r.p })),
        reason: `unsure: confidence ${op.confidence.toFixed(2)}, margin ${margin.toFixed(2)}`,
        ...(choices.length ? { choices } : { hint: whatICanDo(ctx) }),
      }, { choices: choices.map((c) => c.label) });
    }
    reason = `code: "${appHit!.app.name}" is installed → ${appOp} (model unsure: ${operation} ${pctOf(op, operation)})`;
    step("policy", "policy.unsure-place", `unsure, but the words name "${appHit!.app.name}": ${appOp}`, { modelSaid: operation });
    operation = appOp;
  }

  const blocked = notHere(operation, ctx);
  if (blocked) return ruled("policy", "policy.not-here", `${operation} would act outside the place that was named: say what it can do there`, blocked);

  const entry = sk.action(operation);
  const submit = entry ? submitPhrase(text) : undefined;
  if (entry && submit) {
    // the model picked a skill action for "… and send": it can't submit, so ask rather than drop the words
    return ruled("policy", "policy.no-submit", `${operation} can't "${submit}": ask, don't drop the words`, {
      decision: "ask",
      options: [],
      reason: `${operation} can't "${submit}"`,
      hint: `I can ${entry.action.label}, but I can't "${submit}" here. Say it without "${submit}".`,
    });
  }
  if (entry) {
    const s = slotsFor(operation, text, ctx);
    if (s) {
      step("slots", "policy.action-slots", `${operation}: its slots, from the user's words`, { slots: s });
      return finish(operation, s, reason, sk);
    }
    // An item the words don't settle and the model wasn't sure about: ask which, by number.
    const itemSlot = Object.entries(entry.action.slots ?? {}).find(([, k]) => k === "item")?.[0];
    if (itemSlot && ctx.itemAnswer && ctx.items?.length) {
      const viable = ctx.itemAnswer.ranked.filter((r) => r.option !== "none" && r.p >= ITEM_THRESHOLDS.viable && !ctx.excludeItems?.includes(r.option)).slice(0, 3);
      const choices = viable.flatMap((r) => {
        const slots = slotsFor(operation, text, { ...ctx, forceItem: r.option });
        return slots ? [{ operation, slots, label: `${entry.action.label}: ${String(slots[`${itemSlot}_label`] ?? r.option)}` }] : [];
      });
      if (choices.length) return ruled("policy", "policy.which-item", "the words don't settle the item and the model isn't sure: ask which, by number", { decision: "ask", options: [{ operation, p: op.probabilities[operation] ?? 0 }], reason: `${operation}: which one?`, choices }, { choices: choices.map((c) => c.label) });
    }
    // No template backs the model's pick. An action that needs nothing from the words becomes a yes/no question;
    // one that needs a name or words can't be guessed.
    const needsWords = [...entry.action.templates, ...(entry.action.anywhere ?? [])].some((t) => (typeof t === "string" ? t : t.t).includes("{"));
    // Only a confident pick is worth a yes/no question (day 2: a 44% "new terminal tab?" was answered "yes").
    if (!needsWords && (op.probabilities[operation] ?? 0) >= THRESHOLDS.offer) {
      const app = placeFor(entry.skill.places, ctx)!;
      return ruled("policy", "policy.offer", "a confident pick no sentence backs: a yes/no question", {
        decision: "ask",
        options: [{ operation, p: op.probabilities[operation] ?? 0 }],
        reason: `${reason}, but no template fits the words`,
        choices: [{ operation, slots: { app }, label: entry.action.label }],
      });
    }
    return ruled("policy", "policy.no-template", `${operation} needs words no sentence of it found: ask`, {
      decision: "ask",
      options: [{ operation, p: op.probabilities[operation] ?? 0 }],
      reason: `${operation}: no template fits the words`,
      hint: missingHint(operation, entry.action.example ? ["query"] : [], text, ctx),
    });
  }

  let slots = resolveSlots(operation, text, ctx);
  const missing = missingSlots(operation, slots);
  if (missing.length) {
    // The model picked something code can't carry out (open_url with no URL in the words). Fall back to the
    // next operation the model also considered, if its details resolve; an installed-app match lifts the
    // probability floor for the app operations. Otherwise ask.
    const alt = op.ranked
      .slice(0, 3)
      .find(
        (r) =>
          r.option !== operation &&
          r.option !== "none" &&
          !sk.action(r.option) &&
          (r.p >= THRESHOLDS.fallback || (appHit !== undefined && APP_OPS.has(r.option))) &&
          missingSlots(r.option, resolveSlots(r.option, text, ctx)).length === 0,
      );
    const appAlt = !alt && appHit && !APP_OPS.has(operation) && operation === "open_url" && sk.supports("open_app") ? "open_app" : undefined;
    const next = alt?.option ?? appAlt;
    if (!next) {
      return ruled("slots", "policy.missing", `${operation} needs ${missing.join(", ")}, and the words don't have it: ask`, { decision: "ask", options: [{ operation, p: op.probabilities[operation] ?? 0 }], reason: `${operation} without ${missing.join(", ")}`, hint: missingHint(operation, missing, text, ctx) });
    }
    reason = `code: ${operation} has no ${missing.join(", ")} → ${next}${appHit ? ` ("${appHit.app.name}" is installed)` : ` (model ${pctOf(op, next)})`}`;
    step("slots", "policy.fallback", `${operation} has no ${missing.join(", ")}: the model's next pick ${next} can run`, { from: operation, to: next });
    operation = next;
    slots = resolveSlots(operation, text, ctx);
  }
  step("slots", "policy.slots", `${operation}: its slots, from the user's words and code's parsers`, { slots });
  return notHere(operation, ctx) ?? finish(operation, inNamedApp(operation, slots, ctx), reason, sk);
}

function pctOf(op: ChoiceAnswer, option: string): string {
  return `${((op.probabilities[option] ?? 0) * 100).toFixed(0)}%`;
}

export const NUMBER_WORDS = ["one", "two", "three"];

/** How long a destructive action waits for its "confirm": the next thing said, within 30 s. */
export const CONFIRM_MS = 30_000;

/**
 * State across utterances:
 *  - a destructive outcome is held until the user says "confirm" (runs it) or "cancel" (drops it). The answer must be
 *    the very next thing said, within CONFIRM_MS: anything else (half a sentence, chatter, another command) drops it,
 *    so a "yes" much later, or after a reply that wasn't understood, never runs it;
 *  - a question's choices are held for one answer: "yes" when there was one choice, "one" / "the second" else.
 * Anything else drops both and is handled on its own.
 */
export class Session {
  pending: { operation: string; slots: Slots; at: number } | undefined;
  asked: Choice[] | undefined;
  /** The held action that was dropped, and why, for a "confirm" that comes after it. */
  private dropped: { operation: string; why: string } | undefined;
  private readonly sk: SkillSet;
  private readonly now: () => number;

  constructor(skills: SkillSet = commonOnly(), now: () => number = Date.now) {
    this.sk = skills;
    this.now = now;
  }

  handle(outcome: Outcome): Outcome {
    const held = this.pending;
    if (held) {
      const reply = outcome.decision === "act" && (outcome.operation === "confirm" || outcome.operation === "cancel");
      const nothingSaid = outcome.decision === "ignore" && outcome.reason === "nothing said";
      if (!reply && !nothingSaid && outcome.decision !== "confirm") this.drop(held, "you said something else first");
      else if (reply && this.now() - held.at > CONFIRM_MS) this.drop(held, `it waited more than ${CONFIRM_MS / 1000} s`);
    }
    const asked = this.asked;
    this.asked = undefined;
    if (asked && outcome.decision === "act" && (outcome.operation === "confirm" || outcome.operation === "choose")) {
      const n = outcome.operation === "confirm" ? (asked.length === 1 ? 1 : 0) : (outcome.slots.choice ?? 0);
      const picked = n === -1 ? asked.at(-1) : n > 0 ? asked[n - 1] : undefined;
      if (!picked) {
        this.asked = asked;
        step("session", "session.no-pick", `"${outcome.operation}" doesn't pick one of ${asked.length}: ask again`);
        return { decision: "ask", options: [], choices: asked, reason: `"${outcome.operation}" doesn't pick one of ${asked.length}`, hint: `Say ${asked.map((_, i) => `"${NUMBER_WORDS[i]}"`).join(" or ")}.` };
      }
      step("session", "session.answer", `the answer picks "${picked.label}" from the question`, { picked: picked.label, confirmFirst: Boolean(picked.confirm) });
      const answered = finish(picked.operation, picked.slots, `answered: ${picked.label}`, this.sk);
      // a choice offered for a close verb ("close the menu" → "press escape?") still waits for "confirm"
      return this.handle(picked.confirm && answered.decision === "act" ? { ...answered, decision: "confirm" } : answered);
    }
    if (asked && outcome.decision === "act" && outcome.operation === "cancel") return { decision: "ignore", reason: "cancelled the question" };
    if (outcome.decision === "act" && outcome.operation === "choose") return { decision: "ignore", reason: "an answer, but nothing was asked" };
    if (outcome.decision === "ask" && outcome.choices?.length) this.asked = outcome.choices;

    if (outcome.decision === "act" && (outcome.operation === "confirm" || outcome.operation === "cancel")) {
      const pending = this.pending;
      this.pending = undefined;
      if (!pending) {
        const dropped = this.dropped;
        this.dropped = undefined;
        step("session", "session.nothing-waiting", `"${outcome.operation}", but nothing is waiting${dropped ? `: ${dropped.operation} was dropped (${dropped.why})` : ""}`);
        return { decision: "ignore", reason: `"${outcome.operation}" but nothing is waiting${dropped ? ` (${dropped.operation} was dropped: ${dropped.why})` : ""}` };
      }
      if (outcome.operation === "cancel") {
        step("session", "session.cancel", `cancelled: ${pending.operation} is dropped`, { pending: { operation: pending.operation, slots: pending.slots } });
        return { decision: "ignore", reason: `cancelled ${pending.operation}` };
      }
      step("session", "session.confirm", `a spoken "confirm": the waiting ${pending.operation} runs, exactly as planned`, { pending: { operation: pending.operation, slots: pending.slots } });
      return { decision: "act", operation: pending.operation, slots: pending.slots, reason: `confirmed ${pending.operation}`, confirmed: true };
    }
    if (outcome.decision === "confirm") {
      this.pending = { operation: outcome.operation, slots: outcome.slots, at: this.now() };
      this.dropped = undefined;
      step("session", "session.hold", `${outcome.operation} waits for a spoken "confirm" (or "cancel")`, { operation: outcome.operation });
      return outcome;
    }
    if (outcome.decision === "ask" && outcome.choices?.length) step("session", "session.question", "the question's choices are kept for one answer", { choices: outcome.choices.map((c) => c.label) });
    if (outcome.decision === "act" || outcome.decision === "ask") this.pending = undefined;
    return outcome;
  }

  private drop(held: { operation: string }, why: string): void {
    this.pending = undefined;
    this.dropped = { operation: held.operation, why };
    step("session", "session.drop", `${held.operation} no longer waits: ${why}`, { operation: held.operation });
  }
}
