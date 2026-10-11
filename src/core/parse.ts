/**
 * Parsers for everything a decision model must never produce: numbers, ordinals, counts, URLs, keys, media
 * actions, money and durations. Pure code; each returns undefined when it can't parse with confidence.
 */
import { currentProfile, type Profile } from "../profile/profile.ts";

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** "twenty five" → 25, "three hundred" → 300, "1,500" → 1500, "2.5" → 2.5. Undefined if not a number. */
export function parseNumber(phrase: string): number | undefined {
  const t = phrase.trim().toLowerCase().replace(/,/g, "");
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const words = t.split(/[\s-]+/).filter((w) => w !== "and");
  if (words.length === 0) return undefined;
  let total = 0;
  let current = 0;
  for (const w of words) {
    if (w in UNITS) current += UNITS[w]!;
    else if (w in TENS) current += TENS[w]!;
    else if (w === "hundred") current = (current || 1) * 100;
    else if (w === "thousand") { total += (current || 1) * 1000; current = 0; }
    else if (/^\d+$/.test(w)) current += Number(w);
    else return undefined;
  }
  return total + current;
}

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, last: -1,
};

/** "the second result" → 2, "3rd" → 3, "the last one" → -1. */
export function parseOrdinal(text: string): number | undefined {
  for (const w of text.toLowerCase().split(/\s+/)) {
    if (w in ORDINALS) return ORDINALS[w];
    const m = /^(\d+)(?:st|nd|rd|th)$/.exec(w);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** "scroll down three times" → 3, "twice" → 2, "once" → 1. */
export function parseCount(text: string): number | undefined {
  const t = text.toLowerCase();
  if (/\btwice\b/.test(t)) return 2;
  if (/\bonce\b/.test(t)) return 1;
  if (/\bthrice\b/.test(t)) return 3;
  const m = /\b([\w-]+(?: [\w-]+)?) times\b/.exec(t);
  if (!m) return undefined;
  return parseNumber(m[1]!) ?? parseNumber(m[1]!.split(" ").at(-1)!);
}

const TLDS = "com|org|net|io|dev|ai|app|co|in|edu|gov|me|xyz|so|sh|gg|tv";

/**
 * A URL the user said: a domain ("github dot com", "example.com"), localhost with a port ("localhost 3000"), or a
 * site named in my profile ("gmail"). Returns a host[/path] without scheme. Code owns these URLs; the model never
 * writes one. The core knows no site by name.
 */
export function parseUrl(text: string): string | undefined {
  const t = text.toLowerCase().replace(/ dot /g, ".").replace(/ slash /g, "/").replace(/ colon /g, ":");
  const local = /\blocal ?host(?:[ :](\d{2,5}|[a-z]+(?: [a-z]+)*))?/.exec(t);
  if (local) {
    const port = local[1] ? (/^\d+$/.test(local[1]) ? Number(local[1]) : parseNumber(local[1])) : undefined;
    return port !== undefined ? `localhost:${port}` : "localhost";
  }
  const domain = new RegExp(`\\b((?:[a-z0-9-]+\\.)+(?:${TLDS}))(/[\\w./-]*)?\\b`).exec(t);
  if (domain) return domain[1]! + (domain[2] ?? "");
  for (const [name, url] of siteNames(currentProfile())) if (name.test(t)) return url;
  return undefined;
}

/** The profile's site names as patterns, longest first ("google mail" before "google"), built once per profile. */
let sitesBuilt: { from: Profile; names: ReadonlyArray<[RegExp, string]> } | undefined;
function siteNames(p: Profile): ReadonlyArray<[RegExp, string]> {
  if (sitesBuilt?.from === p) return sitesBuilt.names;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = Object.entries(p.sites)
    .sort(([a], [b]) => b.length - a.length)
    .map(([name, url]): [RegExp, string] => [new RegExp(`\\b${escape(name)}\\b`), url]);
  sitesBuilt = { from: p, names };
  return names;
}

export const KEYS: Readonly<Record<string, string>> = {
  enter: "enter", return: "enter", escape: "escape", esc: "escape", tab: "tab", backspace: "backspace",
  delete: "delete", space: "space", spacebar: "space", up: "up", down: "down", left: "left", right: "right",
  home: "home", end: "end", "page up": "pageup", "page down": "pagedown",
};

/** "press enter" → "enter", "hit escape" → "escape". Only when a press/hit verb is present. */
export function parseKey(text: string): string | undefined {
  const m = /\b(?:press|hit|tap|push)(?: the)? ([a-z]+(?: (?:up|down))?)(?: key)?\b/.exec(text.toLowerCase());
  if (!m) return undefined;
  return KEYS[m[1]!] ?? KEYS[m[1]!.split(" ")[0]!];
}

export type MediaAction = "play_pause" | "next" | "previous" | "volume_up" | "volume_down" | "mute";

/** "pause the music" → play_pause, "next song" → next, "turn the volume up" → volume_up. */
export function parseMedia(text: string): MediaAction | undefined {
  const t = text.toLowerCase();
  if (/\b(?:un)?mute\b/.test(t)) return "mute";
  if (/\b(?:volume up|turn (?:it|the volume|the sound) up|louder|increase the volume|raise the volume)\b/.test(t)) return "volume_up";
  if (/\b(?:volume down|turn (?:it|the volume|the sound) down|quieter|softer|lower the volume|decrease the volume)\b/.test(t)) return "volume_down";
  if (/\b(?:next|skip)(?: (?:song|track))?\b/.test(t) && !/\bprevious\b/.test(t)) return "next";
  if (/^(?:i mean )?(?:change|switch) (?:the|this) (?:song|track)$/.test(t)) return "next";
  if (/\b(?:previous|last|go back a) (?:song|track)\b|\bprevious\b/.test(t)) return "previous";
  if (/\b(?:play|pause|resume|stop)(?: (?:the )?(?:music|song|track|video|it))?\b/.test(t)) return "play_pause";
  return undefined;
}

export interface Money {
  amount: number;
  currency: "USD" | "INR" | "EUR" | "GBP";
}

/** "$20", "20 dollars", "twenty five rupees", "€5". */
export function parseMoney(text: string): Money | undefined {
  const t = text.toLowerCase().replace(/,/g, "");
  const sym = /([$₹€£])\s?(\d+(?:\.\d+)?)/.exec(t);
  const symbols: Record<string, Money["currency"]> = { $: "USD", "₹": "INR", "€": "EUR", "£": "GBP" };
  if (sym) return { amount: Number(sym[2]), currency: symbols[sym[1]!]! };
  const m = /\b([\w ]+?) (dollars?|bucks|rupees?|euros?|pounds?)\b/.exec(t);
  if (!m) return undefined;
  const words = m[1]!.split(" ");
  for (let i = 0; i < words.length; i++) {
    const n = parseNumber(words.slice(i).join(" "));
    if (n !== undefined) {
      const unit = m[2]!;
      const currency = unit.startsWith("rupee") ? "INR" : unit.startsWith("euro") ? "EUR" : unit.startsWith("pound") ? "GBP" : "USD";
      return { amount: n, currency };
    }
  }
  return undefined;
}

/** "wait five seconds" → 5000, "in 2 minutes" → 120000. */
export function parseDurationMs(text: string): number | undefined {
  const m = /\b([\w-]+(?: [\w-]+)?) (seconds?|secs?|minutes?|mins?|hours?)\b/.exec(text.toLowerCase());
  if (!m) return undefined;
  const n = parseNumber(m[1]!) ?? parseNumber(m[1]!.split(" ").at(-1)!);
  if (n === undefined) return undefined;
  const unit = m[2]!;
  return n * (unit.startsWith("s") ? 1000 : unit.startsWith("m") ? 60_000 : 3_600_000);
}
