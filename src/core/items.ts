/**
 * Items: the named things a surface shows or knows, such as a page's links, buttons and fields, tabs,
 * contacts or sessions, and how code picks one from the user's words. Labels come from the surface, so they are
 * untrusted text: they are matched by code here, and reach the model only as short options in the `item`
 * question, never in its state.
 *
 * Code first:
 *   - a position in a group ("the first result", "the second link") picks the nth item of that group
 *   - words the user said that appear in exactly one label ("open the documentation")
 *   - the label's sound ("rahool" ≈ Rahul, "sam karter" ≈ Sam Carter), only when nothing shares a word
 * When none of these leaves exactly one item, the model picks among at most 16 (`pickOptions`), and the policy
 * checks its pick (`itemPickOk`).
 */
import { phoneticKey } from "./phonetic.ts";
import { parseOrdinal } from "./parse.ts";
import { step } from "./trace.ts";

/** One named thing on a surface. */
export interface Item {
  /** Stable for the surface: "e20", "chat:rahul", "session:42". */
  id: string;
  /** What the user would call it: the link text, a field's placeholder, a contact's name. Untrusted. */
  label: string;
  /** "link", "button", "textbox", "combobox", "select", "tab", "contact", "session"… A password field is "password". */
  role: string;
  /** A group the surface knows, so "the first result" can be counted: "result", "video", "chat". */
  group?: string;
  /** The place showing it, when several surfaces are connected: only the target's items are used. */
  app?: string;
}

/** Whether an item is a password field. Those are never offered to the model, never matched, and never typed into. */
export const isPassword = (i: Item): boolean => i.role.toLowerCase() === "password";

/**
 * The items a command for this app can mean: the app's own, and those that belong to no app in particular.
 * Password fields are dropped here, before anything looks at the items.
 */
export function itemsFor(items: readonly Item[] | undefined, app: string | undefined, path: readonly string[] = []): Item[] | undefined {
  // the target's own, or, when the target is on the path, those of every place on it (the page's items are Brave's)
  const places = new Set(app !== undefined && path.includes(app) ? [app, ...path] : [app]);
  const mine = items?.filter((i) => (i.app === undefined || places.has(i.app)) && !isPassword(i));
  return mine?.length ? mine : undefined;
}

/** Words that name what kind of item, not which one. */
const ROLE_WORDS: Readonly<Record<string, readonly string[]>> = {
  link: ["link"],
  button: ["button"],
  textbox: ["box", "field", "input"],
  searchbox: ["box", "field", "input"],
  combobox: ["box", "field", "input"],
  select: ["dropdown", "menu", "list"],
  tab: ["tab"],
};
const GROUP_NOUNS = new Set(["result", "results", "link", "links", "video", "videos", "item", "items", "article", "post", "story", "song", "chat", "session", "one"]);
const STOP = new Set(
  "the a an on in into to of and or it its this that one click press tap open select choose go please now then can you my me for with at".split(" "),
);
/** Spoken URL parts: "go to example dot com" names a site, and "com" must not pick the page's "openai.com" link. */
const URL_WORDS = new Set(["dot", "com", "org", "net", "io", "www", "http", "https"]);
const KIND_WORDS = new Set(["link", "links", "button", "box", "field", "input", "tab", "dropdown", "menu", "result", "results", "page", "item", "video", "videos"]);

export const words = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));

/** The words that say WHICH item ("the github link" → github). */
const naming = (phrase: string) => words(phrase).filter((w) => !KIND_WORDS.has(w) && !URL_WORDS.has(w) && !POSITION_WORDS.has(w));
const BARE_POSITION = /^(?:the )?(?:first|second|third|fourth|fifth|last|top|1st|2nd|3rd|4th|5th) (?:result|link|video|item|article|post|story)s?$/;
/** "the second result" says where, not which: never matched against labels. */
const POSITION_WORDS = new Set(["first", "second", "third", "fourth", "fifth", "last", "top", "1st", "2nd", "3rd", "4th", "5th"]);
/** Items that are names people say (and speech-to-text mishears), so they may be matched by sound. */
const NAME_ROLES = new Set(["contact", "chat", "person", "user", "channel", "session", "conversation"]);

/** Labels such as "Delete account", "Place order", "Send": acting on them always needs a spoken confirm. */
const DESTRUCTIVE_LABEL =
  /\b(?:buy|purchase|order|checkout|check\s*out|pay|payment|delete|remove|erase|destroy|send|post|publish|submit|unsubscribe|deactivate|log\s*out|sign\s*out|transfer|donate)\b/i;

/** The sentence ends with an item's whole label ("click log in" and "Log in"), so its last word isn't left hanging. */
export function endsWithLabel(text: string, items: readonly Item[] = []): boolean {
  const said = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return items.some((i) => {
    const label = i.label.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    return label.length > 0 && label.length <= said.length && label.every((w, k) => said[said.length - label.length + k] === w);
  });
}

/**
 * "Order history", "Payment methods", "Track my order": the word names a page about it, not the act. Taken out
 * before the check, so "Delete order history" still waits for a confirm.
 */
const READ_ONLY = /\b(?:orders?|payments?|posts?|purchases?|transfers?)\s+(?:history|status|details|summary|number|id|methods?|settings|tracking)\b|\btrack\s+(?:my\s+)?orders?\b/gi;

export function looksDestructive(label: string | undefined): boolean {
  return DESTRUCTIVE_LABEL.test((label ?? "").replace(READ_ONLY, " "));
}

/**
 * "the second result" → the 2nd item of the "result" group (or of links, when the surface has no groups). The noun is
 * one of GROUP_NOUNS or a group the surface itself named ("the first task" with group "task").
 */
function byPosition(phrase: string, items: readonly Item[]): Item | undefined {
  const m = /\b(first|second|third|fourth|fifth|last|top|1st|2nd|3rd|4th|5th)\s+(\w+)/.exec(phrase.toLowerCase());
  if (!m) return undefined;
  const said = m[2]!;
  const noun = said.replace(/s$/, "");
  const ofGroup = (i: Item) => i.group !== undefined && [said, noun].includes(i.group.toLowerCase());
  if (!GROUP_NOUNS.has(said) && !items.some(ofGroup)) return undefined;
  const n = m[1] === "top" ? 1 : parseOrdinal(m[1]!);
  if (n === undefined) return undefined;
  const grouped = items.filter(ofGroup);
  const pool = grouped.length ? grouped : noun === "link" ? items.filter((i) => i.role === "link") : [];
  if (pool.length === 0) return undefined;
  return n === -1 ? pool.at(-1) : pool[n - 1];
}

/** How many of the naming words a label has. */
function hits(label: string, said: readonly string[]): number {
  const lw = new Set(words(label));
  return said.filter((w) => has(lw, w)).length;
}

const has = (labelWords: ReadonlySet<string>, w: string) => labelWords.has(w) || labelWords.has(w.replace(/s$/, ""));

/** A word said, and how many spoken words it stands for (2 for "flat map" → flatmap). */
interface Said {
  w: string;
  n: number;
}

/** Words said apart that a label writes as one ("geeks for geeks" → geeksforgeeks, "flat map" → flatmap). */
function joined(phrase: string): Said[] {
  const t = phrase.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const out: Said[] = [];
  for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= t.length; i++) out.push({ w: t.slice(i, i + n).join(""), n });
  return out.filter((s) => s.w.length >= 5);
}

/**
 * How well a label fits the naming words: each shared word counts 1 / (how many labels have it), so the word that
 * tells items apart decides ("the closed issues": "closed" is on one label, "issues" on several). A joined word
 * counts for every spoken word it covers ("flat map" fits flatMap() better than flat() or map()).
 */
function weigh(pool: readonly Item[], said: readonly Said[]): Map<Item, number> {
  const sets = new Map(pool.map((i) => [i, new Set(words(i.label))]));
  const df = new Map(said.map((s) => [s.w, [...sets.values()].filter((set) => has(set, s.w)).length]));
  const out = new Map<Item, number>();
  for (const [i, set] of sets) {
    const score = said.reduce((sum, s) => sum + (has(set, s.w) ? s.n / df.get(s.w)! : 0), 0);
    if (score > 0) out.set(i, score);
  }
  return out;
}

/**
 * The item whose label is what was said on its own ("save changes", "new issue", "copy the install command"): every
 * word said is on the label, and they cover at least two thirds of it. Undefined unless exactly one fits best.
 */
export function saysLabel(phrase: string, items: readonly Item[]): Item | undefined {
  // a place on its own ("the third result") points at an item as well as its label does
  if (BARE_POSITION.test(phrase)) return byPosition(phrase, items);
  const said = words(phrase);
  if (said.length === 0) return undefined;
  const fits = items
    .map((i) => {
      const lw = new Set(words(i.label));
      const all = said.every((w) => has(lw, w));
      return { i, cover: all && lw.size ? said.length / lw.size : 0 };
    })
    .filter((f) => f.cover >= 2 / 3);
  if (fits.length === 0) return undefined;
  const best = Math.max(...fits.map((f) => f.cover));
  const top = fits.filter((f) => f.cover === best);
  return top.length === 1 ? top[0]!.i : undefined;
}

/**
 * The one item the phrase names, by code, or undefined. `exclude` rules out items ("no, the other one").
 */
export function matchItem(phrase: string, items: readonly Item[], exclude: readonly string[] = []): Item | undefined {
  const pool = items.filter((i) => !exclude.includes(i.id));
  const positioned = byPosition(phrase, pool);
  if (positioned) return picked(phrase, positioned, "by position in its group");
  const said = naming(phrase);
  if (said.length === 0) return undefined;
  const sayings: Said[] = [...said.map((w) => ({ w, n: 1 })), ...joined(phrase)];
  // a role word narrows the pool ("the email field" → fields only)
  const roleWords = words(phrase).filter((w) => KIND_WORDS.has(w));
  const roled = roleWords.length ? pool.filter((i) => roleWords.some((w) => (ROLE_WORDS[i.role] ?? [i.role]).includes(w))) : [];
  for (const candidates of roled.length ? [roled, pool] : [pool]) {
    const scored = [...weigh(candidates, sayings)].map(([i, n]) => ({ i, n }));
    if (scored.length === 0) continue;
    const best = Math.max(...scored.map((s) => s.n));
    const top = scored.filter((s) => Math.abs(s.n - best) < 1e-9);
    if (top.length === 1) return picked(phrase, top[0]!.i, "the one label with the most words said (rare words weigh more)");
    // a label that is exactly what was said wins a tie ("click new" on a page with "new" and "newest")
    const exact = top.filter((s) => words(s.i.label).join(" ") === said.join(" "));
    if (exact.length === 1) return picked(phrase, exact[0]!.i, "a tie, won by the label that is exactly what was said");
    step("code first", "items.tie", `${top.length} labels fit "${phrase}" equally: the model (or a question) decides`, { tied: top.map((s) => s.i.label) });
    return undefined; // several fit equally: the model (or a question) decides
  }
  // nothing shares a word: the same sound, for names speech-to-text misheard ("rahool" → Rahul). Names only
  // (contacts, chats, sessions), never page links ("second" is not "Security"); a near miss only between keys of
  // 4+ sounds
  const key = phoneticKey(said.join(" "));
  if (key.length < 3) return undefined;
  const sounds = pool.filter((i) => {
    if (!NAME_ROLES.has(i.role)) return false;
    const k = phoneticKey(words(i.label).join(" "));
    return k === key || (Math.min(k.length, key.length) >= 4 && editDistance(k, key) <= 1);
  });
  return sounds.length === 1 ? picked(phrase, sounds[0]!, "the one name with the same sound") : undefined;
}

function picked(phrase: string, item: Item, how: string): Item {
  step("code first", "items.match", `"${phrase}" names "${item.label}": ${how}`, { item: `${item.role} "${item.label}"`, how });
  return item;
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length]![b.length]!;
}

/** The most items the model is offered in one question. */
export const MAX_OPTIONS = 16;
const MAX_LABEL = 28;

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_LABEL ? `${t.slice(0, MAX_LABEL - 1).trimEnd()}…` : t;
}

/** How an item reads as a model option: 'link "TypeSafe — Jev, the System One…"'. */
export function optionText(i: Item): string {
  const label = clip(i.label);
  return label ? `${i.role} "${label}"` : i.role;
}

/**
 * At most 16 items for the model: those sharing a word (or a sound) with what was said first, then the rest in
 * screen order; returned in screen order, so "first" and "second" still line up with the screen.
 */
export function pickOptions(items: readonly Item[], said: string, exclude: readonly string[] = [], max = MAX_OPTIONS): Item[] {
  const pool = items.filter((i) => !exclude.includes(i.id));
  const w = naming(said);
  const key = w.length ? phoneticKey(w.join(" ")) : "";
  const score = (i: Item) => hits(i.label, w) * 2 + (key && phoneticKey(words(i.label).join(" ")) === key ? 1 : 0);
  const chosen = new Set(
    pool
      .map((i, n) => ({ i, n, s: score(i) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.n - b.n)
      .slice(0, max)
      .map((x) => x.i.id),
  );
  for (const i of pool) {
    if (chosen.size >= max) break;
    chosen.add(i.id);
  }
  return pool.filter((i) => chosen.has(i.id));
}

/** The prototype's measured gates for the model's pick (jev-voice-browser constants: 0.45 and 0.35). */
export const ITEM_THRESHOLDS = { confidence: 0.45, top: 0.35, viable: 0.08 } as const;

/**
 * The model's pick counts when it is confident, and when the item shares a word or a sound with what was said,
 * or a position was said ("the second result"). A pick nothing in the words points at is never acted on.
 */
export function itemPickOk(item: Item, said: string, confidence: number, p: number): boolean {
  if (confidence < ITEM_THRESHOLDS.confidence || p < ITEM_THRESHOLDS.top) return false;
  const w = naming(said);
  if (/\b(first|second|third|fourth|fifth|last|top|1st|2nd|3rd|4th|5th)\b/.test(said)) return true;
  if (hits(item.label, w) > 0) return true;
  return w.length > 0 && phoneticKey(w.join(" ")) === phoneticKey(words(item.label).join(" "));
}
