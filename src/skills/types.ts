/**
 * A skill says what one app can do, as plain data a surface hands to the core: its actions, the
 * sentences that ask for each (templates), the kind of each slot, and the risk. It survives JSON, so a surface can
 * send it over a connection and a control panel can list and personalize it. How an action is carried out is the
 * surface's job (src/surface/contract.ts); the core only decides which action, with which of the user's words,
 * and whether it needs a confirm. The model only ever picks among action ids.
 */
import type { AppEntry } from "../core/apps.ts";
import type { ChoiceAnswer } from "../backends/systemone.ts";
import type { Item } from "../core/items.ts";
import type { Risk } from "../core/operations.ts";
import type { Slots } from "../core/slots.ts";
import type { SlotKind } from "./slotkinds.ts";

/** A template, or a template with fixed slot values: `{ t: "play my liked songs", set: { query: "liked songs" } }`. */
export type TemplateSpec = string | { t: string; set: Partial<Slots> };

/** What turning words into slots can see: the names the surface knows, and the last thing looked for. */
export interface CheckCtx {
  /** The places the surface knows. */
  apps: readonly AppEntry[];
  /** What the last command looked for, for "its songs" and "the first song". */
  lastQuery?: string;
  /** The surface's items, the ones ruled out, the model's pick among them, or one the user chose by number. */
  items?: readonly Item[];
  excludeItems?: readonly string[];
  itemAnswer?: ChoiceAnswer;
  forceItem?: string;
}

/** One thing a surface can do, as data: its id, what it's called, its risk, and the sentences that ask for it. */
export interface SkillAction {
  /** "<skill>.<action>", e.g. "spotify.search". */
  id: string;
  /** For replies and control panels: "search in Spotify". */
  label: string;
  /** The option text the model reads: short, contrastive, with an example in the user's words. */
  what: string;
  /** `safe`, `fill`, `confirm` (always waits for a spoken "confirm") or `never` (not done by voice). */
  risk: Risk;
  /** Matched when this skill's app is the target (named, in use, or just opened). */
  templates: readonly TemplateSpec[];
  /** Also matched with no target, because they name the app themselves ("ask cursor to …"). */
  anywhere?: readonly TemplateSpec[];
  /** Also matched whenever the app is open, even when it isn't the target: words only it can mean ("play any Panther song"). */
  ambient?: readonly TemplateSpec[];
  /**
   * Only used to fill slots once the model picked this action, never to decide it: shapes too loose to trust on
   * their own ("claude code {span}").
   */
  afterModel?: readonly TemplateSpec[];
  /** What the things this action names are called ("song", "track", "artist"), for the `name` and `search` kinds. */
  nouns?: readonly string[];
  /** The kind of each template slot (`SLOT_KINDS`). Undeclared slots are "words". */
  slots?: Readonly<Record<string, SlotKind>>;
  /** Needs the last thing searched for ("play the first song"); it fills `query`. */
  usesLastSearch?: boolean;
  /** "always": the model gets this action as an option everywhere, not only when its app is the target. */
  offer?: "target" | "always";
  /** What to say when the model picks this action but its slots can't be found in the words. */
  example?: string;
  /** What doing it looks like, with slots filled in: 'search {app} for "{query}"'. Default "<label> in <app>". */
  does?: string;
  /** Doing it brings the skill's app to the front, so the next command is for that app. Default true. */
  shows?: boolean;
  /** Saying an item's label on its own ("save changes", "new issue") means this action on that item. */
  byLabel?: boolean;
}

/** What one place can do, as plain data a surface hands to the engine. It survives JSON, so it can travel over a connection. */
export interface Skill {
  /** Unique among the surface's skills. */
  id: string;
  /** The places this skill is for (one browser skill for Brave, Chrome and Edge); none = any place (window actions). */
  places: readonly string[];
  /** Its actions. */
  actions: readonly SkillAction[];
  /**
   * Common operations that happen inside this place when it is named ("search for X on Brave" searches in Brave's
   * page, not elsewhere), because its surface carries them out.
   */
  handles?: readonly string[];
}
