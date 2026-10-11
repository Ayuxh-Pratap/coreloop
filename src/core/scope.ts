/**
 * Which app a command is meant for, and the command without the words that said so:
 *
 *   1. an app named with on/in ("search for panther on spotify", "on the spotify app, search for panther")
 *      or "in this window" / "here"
 *   2. the app in front
 *   3. the app coreloop just opened, while its window may still be on its way
 *
 * Only an installed app named as a whole (name, alias, plural or sound; never one shared word) counts, so "search
 * for cafes in paris" keeps its words. Dictated words keep everything except a trailing "in <app>" ("type hello in
 * the terminal"); a sentence one of the surface's own templates reads whole ("paste X into claude code") is left whole.
 */
import { APP_NOUNS, HERE_PHRASE, nameApp, type AppEntry } from "./apps.ts";
import type { SlotContext, Target } from "./slots.ts";
import { step } from "./trace.ts";

export interface Scope {
  /** The command without the target words. */
  text: string;
  target?: Target;
  /** The words that named the target ("on the brave browser"), if any. */
  named?: string;
}

const PREPOSITIONS = new Set(["on", "in", "inside", "using", "via"]);
const DETERMINERS = new Set(["the", "my"]);
const SUFFIXES = new Set(APP_NOUNS);
const HERE = new RegExp(`^(?:${HERE_PHRASE})$`);

/** Sentences whose words are inserted as said ("type", "paste", "tell claude to …"). */
const DICTATION = /^(?:paste|put|send|type|write|enter|tell|ask|have|get|give|message|text)\b/;

function nameAt(words: readonly string[], apps: readonly AppEntry[]): { app?: string; here?: true } | undefined {
  if (HERE.test(words.join(" "))) return { here: true };
  let w = [...words];
  while (w.length && DETERMINERS.has(w[0]!)) w = w.slice(1);
  while (w.length > 1 && SUFFIXES.has(w.at(-1)!)) w = w.slice(0, -1);
  if (w.length === 0 || w.length > 3) return undefined;
  const phrase = w.join(" ");
  if (HERE.test(phrase)) return { here: true };
  const hit = nameApp(phrase, apps);
  return hit ? { app: hit.app.name } : undefined;
}

/** "… on spotify" / "on the spotify app, …": the app and the rest of the command. */
export function namedTarget(text: string, apps: readonly AppEntry[], keepWhole?: (text: string) => boolean): { app?: string; here?: true; rest: string; named: string } | undefined {
  const dictation = DICTATION.test(text);
  if (dictation && keepWhole?.(text)) return undefined;
  const words = text.split(" ");
  // trailing: "<command> on [the] <app> [app]"; for dictation only the very end, only "in/into/on"
  for (let p = words.length - 2; p >= 1; p--) {
    if (!PREPOSITIONS.has(words[p]!) && !(dictation && words[p] === "into")) continue;
    if (dictation && p < words.length - 4) break;
    const found = nameAt(words.slice(p + 1), apps);
    if (found) return { ...found, rest: words.slice(0, p).join(" "), named: words.slice(p).join(" ") };
  }
  // leading: "on [the] <app> [app] <command>", the longest name that resolves
  if (!dictation && PREPOSITIONS.has(words[0]!)) {
    for (let end = Math.min(words.length - 1, 5); end >= 2; end--) {
      const found = nameAt(words.slice(1, end), apps);
      if (found && end < words.length) return { ...found, rest: words.slice(end).join(" "), named: words.slice(0, end).join(" ") };
    }
  }
  return undefined;
}

export function resolveScope(text: string, ctx: SlotContext): Scope {
  const scope = scopeOf(text, ctx);
  const why = { named: "named in the words", here: '"here" / "this window": where I am', front: "where I am (the innermost place on the path)", recent: "the place coreloop just opened" } as const;
  step("which app", "scope.target", scope.target ? `the command goes to ${scope.target.app}: ${why[scope.target.via]}` : "no target: nothing is in front", {
    target: scope.target,
    path: ctx.path,
    ...(scope.named ? { named: scope.named, command: scope.text } : {}),
  });
  return scope;
}

function scopeOf(text: string, ctx: SlotContext): Scope {
  // a template that names its own app ("paste X into claude code") reads the whole sentence, so it stays whole
  const named = namedTarget(text, ctx.apps, (t) => Boolean(ctx.skills?.matchAnywhere(t, { apps: ctx.apps, lastQuery: ctx.lastQuery })));
  if (named?.app) return { text: named.rest, target: { app: named.app, via: "named" }, named: named.named };
  if (named?.here) return { text: named.rest, target: ctx.front ? { app: ctx.front, via: "here" } : undefined, named: named.named };
  if (ctx.front) return { text, target: { app: ctx.front, via: "front" } };
  if (ctx.recent) return { text, target: { app: ctx.recent, via: "recent" } };
  return { text };
}
