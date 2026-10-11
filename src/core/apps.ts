/**
 * Which app the user means. Pure code: the phrase after the verb is matched against the apps the surfaces report,
 * by exact name, the spoken names they declare and word overlap. A clear match is decisive evidence for the policy
 * ("start vs code" is an app, whatever the model thought). A name nothing else matches is tried by sound
 * ("open cloud" → Claude), only against this list. The core knows no app by name: every alias and noise
 * word comes from a surface's view or from my profile.
 */
import { phoneticKey } from "./phonetic.ts";
import { currentProfile } from "../profile/profile.ts";

/**
 * A place the user can name or be in: an app, a tab, a site, a page, a route, a chat. The common operations call them
 * apps (`open_app`, `focus_app`, `close_app`) whatever they are.
 */
export interface Place {
  /** Display name, e.g. "Visual Studio Code", "Pricing". */
  name: string;
  /** The surface's own id for it, such as a route's path. The engine never reads it. */
  id: string;
  /** What the surface calls this kind of place ("app", "tab", "page", "route"), for replies. Default "app". */
  kind?: string;
  /** Spoken names the surface declares for it, lowercase ("vs code", "the browser"). */
  aliases?: readonly string[];
  /** Words in its name too common on this surface to name a place alone ("windows", "microsoft", "studio"). */
  generic?: readonly string[];
}

/** The engine's name for a place in its list. */
export type AppEntry = Place;

export interface AppMatch {
  app: AppEntry;
  score: number;
  via: "name" | "alias" | "words" | "sound";
}

/** My names for an app (profile/apps.json nicknames). */
const nicknames = (app: AppEntry): readonly string[] => currentProfile().nicknames[app.name] ?? [];
/** Names declared for an app: by its surface ("the browser") and by me. */
const declaredNames = (app: AppEntry): readonly string[] => [...(app.aliases ?? []).map((n) => n.toLowerCase()), ...nicknames(app)];

const TARGET =
  /^(?:open|launch|start|run|fire up|boot up|load|bring up|bring back|switch to|switch back to|go back to|go to|jump to|take me to|navigate to|head to|show me|show|focus(?: on)?|close|quit|kill|exit|shut down|shut|terminate|end)\s+(?:up\s+)?(?:the |my |a )?(.+?)(?: app| application| window| program)?$/;

/** "bring claude code on top", "put spotify to the front": always a switch to that app. */
export const TO_FRONT = /^(?:bring|put|get|move|pull) (?:up |back )?(?:the |my )?(.+?) (?:on top|to the top|to the front|to front|in front|up front|forward)$/;

/** The words naming the target: "fire up obs" → "obs", "go back to vs code" → "vs code". */
export function targetPhrase(text: string): string | undefined {
  return (TO_FRONT.exec(text)?.[1] ?? TARGET.exec(text)?.[1])?.trim() || undefined;
}

/** Words said after an app's name that aren't part of it ("the brave browser", "the spotify app"), for every surface. */
export const APP_NOUNS: readonly string[] = ["app", "application", "program", "window", "browser", "client", "desktop"];

/** Wherever the user is now, on any surface: "here", "this window", "this tab", "this page". */
export const HERE_PHRASE = "here|this one|(?:this|the current|current) (?:window|app|tab|page|site)|the window in front";

/** The current window rather than a named app ("close this window", "close it"). */
export function meansCurrentWindow(phrase: string | undefined): boolean {
  return phrase !== undefined && /^(?:this|that|it|this one|that one|current|this window|that window|the current one)$/.test(phrase);
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((w) => w.length > 1);

/** English words that never name an app on their own. A surface adds its own (`AppEntry.generic`). */
const GENERIC = ["app", "apps", "application", "desktop", "tool", "tools", "program", "the", "my"];

/** The noise words for an app list: the core's, plus every word a surface declared ("windows" is not Windows PowerShell). */
const genericCache = new WeakMap<readonly AppEntry[], ReadonlySet<string>>();
function genericWords(apps: readonly AppEntry[]): ReadonlySet<string> {
  let set = genericCache.get(apps);
  if (!set) {
    set = new Set([...GENERIC, ...apps.flatMap((a) => (a.generic ?? []).map((w) => w.toLowerCase()))]);
    genericCache.set(apps, set);
  }
  return set;
}

/**
 * Candidates for a phrase, best first. Scores: exact name 1.0, alias 0.95; otherwise every distinctive spoken
 * word found in the name scores 0.8, minus 0.05 per extra word in the name (the shortest fit wins), and a
 * partial overlap at most 0.5.
 */
export function matchApps(phrase: string, apps: readonly AppEntry[]): AppMatch[] {
  const p = phrase.toLowerCase().trim();
  const pw = words(p);
  const out: AppMatch[] = [];
  const generic = genericWords(apps);
  // my nickname for an app beats a name a surface declared for another
  const mine = apps.some((a) => nicknames(a).includes(p));
  for (const app of apps) {
    const name = app.name.toLowerCase();
    if (name === p) {
      out.push({ app, score: 1, via: "name" });
      continue;
    }
    if ((mine ? nicknames(app) : declaredNames(app)).includes(p)) {
      out.push({ app, score: 0.95, via: "alias" });
      continue;
    }
    const distinctive = pw.filter((w) => !generic.has(w));
    if (distinctive.length === 0) continue;
    const nw = words(name);
    const shared = distinctive.filter((w) => nw.includes(w)).length;
    if (shared === 0) continue;
    const score = shared === distinctive.length ? Math.max(0.5, 0.8 - 0.05 * (nw.length - shared)) : 0.5 * (shared / distinctive.length);
    out.push({ app, score, via: "words" });
  }
  return out.sort((a, b) => b.score - a.score);
}

export const APP_THRESHOLDS = { strong: 0.6, margin: 0.15 } as const;

/**
 * An installed app named anywhere in the sentence, by exact name or alias ("pull up chrome", "switch over to
 * spotify"), for verbs the target pattern doesn't know. Longer names win ("google chrome" over "chrome").
 */
export function findAppInText(text: string, apps: readonly AppEntry[]): AppMatch | undefined {
  const w = text.toLowerCase().split(" ");
  const generic = genericWords(apps);
  for (let n = Math.min(4, w.length); n >= 1; n--) {
    const hits: AppMatch[] = [];
    for (let i = 0; i + n <= w.length; i++) {
      const gram = w.slice(i, i + n).join(" ");
      if (n === 1 && generic.has(gram)) continue;
      for (const m of matchApps(gram, apps)) if (m.via !== "words" && !hits.some((h) => h.app === m.app)) hits.push(m);
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return undefined; // two apps named: ambiguous
  }
  return undefined;
}

function clearBest(phrase: string, apps: readonly AppEntry[]): AppMatch | undefined {
  const [best, second] = matchApps(phrase, apps);
  if (!best || best.score < APP_THRESHOLDS.strong) return undefined;
  if (second && best.score - second.score < APP_THRESHOLDS.margin) return undefined;
  return best;
}

/** The one app whose name or alias sounds like the phrase ("cloud" → Claude), if exactly one does. */
export function soundsLikeApp(phrase: string, apps: readonly AppEntry[]): AppMatch | undefined {
  if (phrase.replace(/[^a-z]/g, "").length < 4) return undefined;
  const key = phoneticKey(phrase);
  if (key.length < 2) return undefined;
  const hits = apps.filter((a) => [a.name.toLowerCase(), ...declaredNames(a)].some((n) => phoneticKey(n) === key));
  return hits.length === 1 ? { app: hits[0]!, score: 0.7, via: "sound" } : undefined;
}

/**
 * An app the phrase names as a whole: its name, an alias, its sound, or all its distinctive words. Never one shared
 * word ("the screen" is not On-Screen Keyboard, "center" is not Steam Support Center). For targets and repairs.
 */
export function nameApp(phrase: string | undefined, apps: readonly AppEntry[]): AppMatch | undefined {
  const hit = resolveApp(phrase, apps);
  return hit && (hit.via !== "words" || hit.score >= 0.8) ? hit : undefined;
}

/**
 * The one app the phrase clearly names, or undefined when there's none or it's ambiguous. Tried in order: the
 * phrase as said, without a plural "s" ("terminals"), then by sound ("cloud").
 */
export function resolveApp(phrase: string | undefined, apps: readonly AppEntry[]): AppMatch | undefined {
  if (!phrase) return undefined;
  const p = phrase.toLowerCase().trim();
  return clearBest(p, apps) ?? (p.length > 4 && p.endsWith("s") ? clearBest(p.slice(0, -1), apps) : undefined) ?? soundsLikeApp(p, apps);
}
