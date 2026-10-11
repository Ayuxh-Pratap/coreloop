/**
 * Turns raw speech-to-text output into the text every later stage works on. Pure code, no model.
 *
 * - lowercases and strips punctuation Parakeet adds ("Open Spotify." → "open spotify")
 * - fixes the speech-to-text slips in my profile ("clawed code" → "claude code"); the core knows none itself
 * - strips politeness and filler around a command ("um can you please open discord for me" → "open discord")
 *
 * Words inside the command are never touched: a span the user wants pasted must survive verbatim.
 */
import { currentProfile, type Profile } from "../profile/profile.ts";
import { step } from "./trace.ts";

/** A sentence after normalising. */
export interface Normalised {
  /** What was heard. */
  raw: string;
  /** Lowercase, without punctuation or filler: what every later step works on. */
  text: string;
  /** `text`, as words. */
  words: string[];
  /** The profile's fixes that were applied, such as "clawed code → claude code". */
  fixes: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternation = (heard: string[]) => [...heard].sort((a, b) => b.length - a.length).map(escape).join("|");

interface Tables {
  /** Speech-to-text slips → the name the user meant (the profile's aliases): matched on whole words, anywhere. */
  aliases: ReadonlyArray<[RegExp, string]>;
  /** First-word slips ("nose spotify" → "close spotify"), applied after fillers are stripped. */
  starts: ReadonlyArray<[RegExp, string]>;
  /** The profile's own sentences: the whole sentence X means the command Y. */
  phrases: ReadonlyMap<string, string>;
}

/** The profile's tables, built once per profile handed in (nothing is read at import). */
let built: { from: Profile; tables: Tables } | undefined;
function tablesFor(p: Profile): Tables {
  if (built?.from === p) return built.tables;
  const tables: Tables = {
    aliases: Object.entries(p.aliases.phrases).map(([meant, heard]): [RegExp, string] => [new RegExp(`\\b(?:${alternation(heard)})\\b`, "g"), meant]),
    starts: Object.entries(p.aliases.starts).map(([meant, heard]) => [new RegExp(`^(?:${alternation(heard)})\\b`), meant]),
    phrases: new Map(p.phrases.map((ph) => [ph.say, ph.do])),
  };
  built = { from: p, tables };
  return tables;
}

const LEADING_FILLER =
  /^(?:(?:um+|uh+|er+|hmm+|okay|ok|so|hey|hey computer|alright|well|now|and)\b[ ,]*)*(?:(?:can|could|would|will) you(?: please)?|please|i want to|i'd like to|i would like to|i need to|let's|let us)?[ ,]*/;
const TRAILING_FILLER = /[ ,]*(?:please|for me|now|thanks|thank you|right now)$/;
/** Hesitation sounds carry no meaning anywhere, in a command or in dictated text ("paste thanks uh for the update"). */
const HESITATION = /\b(?:u+h+|u+m+|uhm|erm|hmm+)\b/g;
/** Speech-to-text sometimes hears the breath before a command as "a" ("A type see you tomorrow"). */
const LEAD_ARTIFACT = /^a (?=(?:open|close|type|paste|search|go|switch|press|hit|play|pause|turn|mute|next|send|launch|start|bring|show|google|look)\b)/;

/**
 * From what speech-to-text heard to the text every later step works on: lowercase, punctuation and filler off,
 * spelled letters joined, and the profile's fixes applied. The words a user wants typed are never changed.
 * @param leading Words the surface's sentences start with, so a breath heard as "a" before them is dropped too.
 */
export function normalise(raw: string, leading: ReadonlySet<string> = new Set()): Normalised {
  const { aliases: ALIASES, starts: STARTS, phrases: PHRASES } = tablesFor(currentProfile());
  let text = raw
    .toLowerCase()
    .replace(/[“”"]/g, "")
    .replace(/[!?,;]+/g, " ")
    .replace(/\.(?=\s|$)/g, " ") // sentence-final dots, but keep "example.com"
    .replace(/\s+/g, " ")
    .trim();
  step("normalise", "normalise.clean", "lowercased, punctuation off", { raw, text });

  const fixes: string[] = [];
  // A name spelled out letter by letter ("p a n t h e r"): three or more single letters in a row are one word.
  text = text.replace(/\b[a-z](?: [a-z]\b){2,}/g, (m) => {
    const word = m.replace(/ /g, "");
    fixes.push(`${m} → ${word}`);
    return word;
  });
  for (const [pattern, replacement] of ALIASES) {
    text = text.replace(pattern, (m) => {
      if (m !== replacement) fixes.push(`${m} → ${replacement}`);
      return replacement;
    });
  }

  if (fixes.length) step("normalise", "normalise.fixes", "spelled-out letters joined, my mishearings fixed", { text, fixes: [...fixes] });

  const stripped = text
    .replace(HESITATION, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LEADING_FILLER, "")
    .replace(LEAD_ARTIFACT, "")
    .replace(/^a (\S+) /, (m, w: string) => (leading.has(w) ? `${w} ` : m))
    .replace(TRAILING_FILLER, "")
    .trim();
  // Never strip a whole utterance away: "um okay so" stays as said, so it can be judged as chit-chat.
  if (stripped && stripped !== text) step("normalise", "normalise.filler", "politeness and filler around the command dropped", { from: text, to: stripped });
  if (stripped) text = stripped;
  for (const [pattern, replacement] of STARTS) {
    text = text.replace(pattern, (m) => {
      fixes.push(`${m} → ${replacement}`);
      return replacement;
    });
  }

  // a sentence of my own means another command, which then goes through every rule as if I'd said it
  const meant = PHRASES.get(text);
  if (meant) {
    step("normalise", "normalise.phrase", "a sentence of my own (profile) means another command", { said: text, means: meant });
    fixes.push(`"${text}" means "${meant}"`);
    text = meant;
  }
  step("normalise", "normalise.done", "the text every later stage works on", { text, fixes });

  return { raw, text, words: text.split(" ").filter(Boolean), fixes };
}
