/**
 * Cleaning a query span: what the user wants found, without the description they added for a person
 * ("Panther, who is a music artist" → "panther"). Only ever cuts words away; never adds any.
 */
import type { CheckCtx } from "./types.ts";

/** "who is a music artist", "which is a band": said to explain the name, not part of it. */
const DESCRIPTION = / (?:(?:who|which|that) (?:is|was|are|were)|who's|that's)\b.*$/;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alt = (nouns: readonly string[]) => nouns.map(esc).join("|");

/** Words that are never a name on their own ("search for something", "play it"). */
const VAGUE = ["something", "anything", "it", "that", "this", "one", "stuff"];

/** "play some music" with "music" taken by the template leaves "some": still not a name. */
const ONLY_DETERMINERS = /^(?:(?:some|any|a|an|the|my|this|that|good|nice|random|more|new|few) ?)+$/;

/** "some Arctic Monkeys": how much, not who. */
const QUANTITY = /^(?:some|a few|a bit of|a little|any|more) (?=\S)/;

/** "play next song" is the next track, not a search for "next song". */
const NEXT_WORDS = /^(?:the )?(?:next|previous|last|again|it again)\b/;

/**
 * What the user wants found, or undefined when the words name nothing. `nouns` are the words the action's own
 * things are called (a music skill's "song", "track", "music"): "some music" is no name there.
 */
export function cleanQuery(span: string | undefined, nouns: readonly string[] = []): string | undefined {
  if (!span) return undefined;
  const q = span.replace(DESCRIPTION, "").replace(QUANTITY, "").trim();
  const words = alt([...VAGUE, ...nouns]);
  const notAName = new RegExp(`^(?:(?:some|any|a|the|my|this|that|good|nice|random) )*(?:${words})$`);
  if (!q || notAName.test(q) || ONLY_DETERMINERS.test(q) || NEXT_WORDS.test(q)) return undefined;
  return q;
}

/** "which appeared on the screen", "on my screen": where the user saw it, not part of the name. */
const ON_SCREEN = /(?: (?:which|that) (?:appeared|appears|showed|shows|is|was)(?: up)?)?(?: on (?:the|my) screen| up there| there)$/;

const POSITION = /^(?:first|second|third|fourth|fifth|top|last|next|previous|\d+(?:st|nd|rd|th)?)(?: one)?$/;

/**
 * A thing's name from the words (the generic kind that was "music"), or the last thing searched for when the
 * words point at it: "its <noun>", "this <noun>", "them". `nouns` come from the action ("song", "artist", "album").
 */
export function nameQuery(span: string | undefined, ctx: CheckCtx, nouns: readonly string[] = []): string | undefined {
  if (!span) return undefined;
  const t = span.replace(ON_SCREEN, "").trim();
  const n = nouns.length ? alt(nouns) : undefined;
  const pronoun = new RegExp(
    `^(?:(?:its|his|her|their|this|that|the same)${n ? ` (?:${n})` : " one"}|(?:this|that|the same) one|them|its|his|her|their)$`,
  );
  if (pronoun.test(t)) return ctx.lastQuery;
  const q = cleanQuery(t, nouns);
  if (!q) return undefined;
  const name = q
    .replace(/^(?:the|a|an) (?=\S)/, "")
    .replace(/'s$/, "")
    .replace(n ? new RegExp(` (?:${n})$`) : /$^/, "")
    .trim();
  // "play the first song" names a position in a list, not a song called "first"
  if (POSITION.test(name)) return undefined;
  return name || undefined;
}
