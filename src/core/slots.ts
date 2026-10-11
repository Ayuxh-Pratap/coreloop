/**
 * Once an operation is chosen, code fills in what it needs from the user's words. The model picked the
 * operation; it never supplies an app, a URL, a key, a media action or text to type.
 */
import { findAppInText, meansCurrentWindow, resolveApp, targetPhrase, type AppEntry } from "./apps.ts";
import type { SkillSet } from "../skills/skillset.ts";
import type { ChoiceAnswer } from "../backends/systemone.ts";
import type { Item } from "./items.ts";
import { parseKey, parseMedia, parseNumber, parseOrdinal, parseUrl, type MediaAction } from "./parse.ts";
import { spanFor } from "./spans.ts";
import { step } from "./trace.ts";
import { currentProfile } from "../profile/profile.ts";

/** An action's details, all from the user's words or from parsers: never from the model. */
export interface Slots {
  /** Words to type, paste or search for: a span of what the user said. */
  span?: string;
  /** A key to press. */
  key?: string;
  /** A media action. */
  media?: MediaAction;
  /** An address, from the URL parser. */
  url?: string;
  /** A place, by its name. */
  app?: string;
  /** The place's id, from the surface. */
  app_id?: string;
  /** "close this window": whatever window is in front when the action runs. */
  window?: "current";
  /** What to look for inside an app (a skill's search or play): a span of the user's words. */
  query?: string;
  /** What kind of thing the query names, when the words say so ("the song …" → track). */
  kind?: string;
  /** The answer to a question: 1, 2, 3 (-1 = the last one). */
  choice?: number;
  /** "type hello and send": press Enter after the words (only after a spoken confirm). */
  submit?: boolean;
  /** An item on the surface: its id. */
  item?: string;
  /** The item's label, for replies and the destructive-label check. */
  item_label?: string;
  /** Slots a skill declares for itself ("direction", "amount"…). */
  [slot: string]: string | number | boolean | undefined;
}

/** The app a command is meant for: the one named ("on Spotify"), the one in front, or the one just opened. */
/** The place a command is for, and how it was chosen: named in the words, "here", in front, or just opened. */
export interface Target {
  /** The place. */
  app: string;
  via: "named" | "here" | "front" | "recent";
}

/** What slot resolution can see beyond the user's words. */
export interface SlotContext {
  /** The places the surface knows. */
  apps: readonly AppEntry[];
  /** What the connected surface can do (its skills), next to the common operations. None by default. */
  skills?: SkillSet;
  /** Where the user is: the innermost place on the path, when the surface was read. */
  front?: string;
  /** The whole path, outermost first ("Brave", "localhost:3000", "Pricing"): skills are tried along it, inner first. */
  path?: readonly string[];
  /** The place the engine just brought to the front, while its window may still be opening. */
  recent?: string;
  /** Set by the pipeline once the target is resolved. */
  target?: Target;
  /** The places that are open. */
  open?: readonly string[];
  /** What the last command looked for, for "its music", "the artist profile", "the first song". */
  lastQuery?: string;
  /** The named things the surface shows: links, buttons, fields, tabs, contacts. Their labels are untrusted. */
  items?: readonly Item[];
  /** Password fields on the screen: never offered, but typing into one by name is refused. */
  secrets?: readonly Item[];
  /** Items ruled out ("no, the other one"). */
  excludeItems?: readonly string[];
  /** The model's answer to the item question, when it was asked. */
  itemAnswer?: ChoiceAnswer;
  /** Plan for this item regardless of the words (a numbered choice the user picked). */
  forceItem?: string;
}

export const NO_CONTEXT: SlotContext = { apps: [] };

/** The slots each operation can't act without. */
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  paste_text: ["span"],
  type_text: ["span"],
  search_web: ["span"],
  press_key: ["key"],
  media: ["media"],
  open_url: ["url"],
  open_app: ["app"],
  focus_app: ["app"],
};

function appSlots(text: string, ctx: SlotContext, allowCurrent: boolean): Slots {
  const phrase = targetPhrase(text);
  if (allowCurrent && meansCurrentWindow(phrase)) return { window: "current" };
  const hit = resolveApp(phrase, ctx.apps) ?? findAppInText(text, ctx.apps);
  const how = { name: "its name", alias: "a name its surface or my profile gave it", words: "all its distinctive words", sound: "its sound (a misheard name)" } as const;
  step("slots", "slots.place", hit ? `"${phrase ?? text}" names ${hit.app.name}, by ${how[hit.via]}` : `"${phrase ?? text}" names no place code knows`, hit ? { place: hit.app.name, via: hit.via, score: hit.score } : { phrase });
  return hit ? { app: hit.app.name, app_id: hit.app.id } : {};
}

/** "… and send", "… and run it": said to the computer, not part of the words. */
const SUBMIT = / (?:and|then|and then) (?:send|send it|send that|send this|submit|submit it|press enter|hit enter|run it|run that|execute it)$/;

/** "… and send" at the end of a sentence: the words that say it, or undefined. */
export function submitPhrase(text: string): string | undefined {
  return SUBMIT.exec(text)?.[0].trim();
}

function dictated(span: string | undefined): Slots {
  if (!span) return {};
  const submit = SUBMIT.test(span);
  let words = span.replace(SUBMIT, "");
  // a word I add after dictation ("npm run dev command"), from my profile; the core knows none
  const end = currentProfile().dictationEnds.find((e) => words.endsWith(` ${e}`));
  if (end && words.split(" ").length - end.split(" ").length >= 2) words = words.slice(0, -(end.length + 1));
  return submit ? { span: words, submit: true } : { span: words };
}

/** Typing into an app the user named ("type hello in the terminal") goes to that app. */
function namedApp(ctx: SlotContext): Slots {
  const t = ctx.target;
  if (t?.via !== "named") return {};
  const app = ctx.apps.find((a) => a.name === t.app);
  return { app: t.app, ...(app ? { app_id: app.id } : {}) };
}

export function resolveSlots(operation: string, text: string, ctx: SlotContext = NO_CONTEXT): Slots {
  switch (operation) {
    case "paste_text":
      return { ...dictated(spanFor("paste", text)), ...namedApp(ctx) };
    case "type_text":
      return { ...dictated(spanFor("type", text)), ...namedApp(ctx) };
    case "search_web":
      return { span: spanFor("search", text) };
    case "press_key":
      return { key: parseKey(text) };
    case "media":
      return { media: parseMedia(text) };
    case "open_url":
      return { url: parseUrl(text) };
    case "open_app":
    case "focus_app":
      return appSlots(text, ctx, false);
    case "close_app":
      return appSlots(text, ctx, true);
    case "choose":
      return { choice: parseOrdinal(text) ?? parseNumber(text.split(" ").at(-1)!) };
    default:
      return {};
  }
}

export function missingSlots(operation: string, slots: Slots): string[] {
  if (operation === "close_app") return slots.app || slots.window ? [] : ["app"];
  return (REQUIRED[operation] ?? []).filter((k) => slots[k] === undefined);
}
