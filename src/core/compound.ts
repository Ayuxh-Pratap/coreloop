/**
 * Two commands in one sentence ("open Spotify and search for Panther").
 *
 * The pipeline does one action per sentence, and the second half often depends on the first ("search" here means
 * inside Spotify, not the web). Until running several steps in a row is built, the safe answer is to say so and ask,
 * never to do the first half and silently drop the rest.
 *
 * Dictated text is left alone: in "type salt and pepper" or "tell claude to open the file and run the tests", the
 * "and" is part of the words to insert.
 */

/** Sentences whose first verb carries dictated text: everything after it is the user's words. */
const DICTATION = /^(?:paste|put|send|type|write|enter|tell|ask|have|get|give)\b/;

/** How a second command starts after "and" / "then". */
const COMMAND_START =
  /^(?:open|launch|start|run|close|quit|kill|exit|switch to|go to|go back to|bring up|show me|search|google|look up|find|send|message|text|call|email|paste|type|write|press|hit|play|pause|mute|unmute|turn|skip|next|click|scroll|create|make)\b/;

const JOINER = / (?:and then|and also|and after that|and|then|after that) /;

/**
 * The commands in a sentence when there is more than one, else undefined. A second command starts with a common
 * verb or with a word one of the surface's sentences starts with (`leading`, "… and like it").
 */
export function splitCompound(text: string, leading: ReadonlySet<string> = new Set()): string[] | undefined {
  if (DICTATION.test(text)) return undefined;
  const parts = text.split(JOINER).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  if (!parts.slice(1).every((p) => COMMAND_START.test(p) || leading.has(p.split(" ")[0]!))) return undefined;
  return parts;
}
