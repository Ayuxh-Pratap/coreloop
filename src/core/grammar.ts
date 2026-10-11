/**
 * Fast path for closed, unambiguous phrasings: when the WHOLE utterance matches one of these shapes, code
 * decides the operation and the model isn't called at all (~0 ms instead of ~130 ms). Only shapes with exactly
 * one sensible reading belong here; anything open-ended goes to the model.
 */
import { KEYS, parseMedia } from "./parse.ts";

export interface GrammarHit {
  operation: string;
  rule: string;
}

const KEY_NAMES = Object.keys(KEYS).sort((a, b) => b.length - a.length).join("|");

const RULES: ReadonlyArray<[string, RegExp, string]> = [
  ["choose", /^(?:(?:the )?(?:first|second|third|last)(?: one)?|one|two|three|(?:number|option) (?:one|two|three|1|2|3)|1|2|3)$/, "answer by number"],
  ["confirm", /^(?:yes|yeah|yep|yup|sure|confirm|confirmed|do it|yes do it|go ahead|yes go ahead|ok do it|okay do it)$/, "confirm phrase"],
  ["cancel", /^(?:(?:no|nah|nope)(?: (?:forget it|never ?mind|cancel(?: that)?|don't|stop|leave it))?|cancel(?: that)?|never ?mind|forget (?:it|that)|abort|don't|no don't|don't do (?:it|that)|no don't do (?:it|that))$/, "cancel phrase"],
  ["press_key", new RegExp(`^(?:press|hit|tap|push)(?: the)? (?:${KEY_NAMES})(?: key)?$`), "press <key>"],
  ["search_web", /^(?:search(?: the web| online| google)? for|google|look up) .+/, "search verb"],
  [
    "media",
    /^(?:play|pause|resume|mute|unmute|next|skip|previous|(?:play |pause |resume )?(?:the )?(?:music|song|track)|(?:next|previous|skip(?: this)?|last) (?:song|track)|volume (?:up|down)|louder|quieter|turn (?:it|the volume|the sound|the music) (?:up|down)|(?:pause|stop|resume|play) the (?:music|song|track|video)|(?:go to |skip to |play )?the (?:next|previous|last) (?:song|track|one)|(?:change|switch) (?:the|this) (?:song|track)|skip (?:this one|it|this|that)|stop (?:this one|this song|this track|it|playing|the song|this|that))$/,
    "media phrase",
  ],
];

export function matchGrammar(text: string): GrammarHit | undefined {
  for (const [operation, re, rule] of RULES) {
    if (!re.test(text)) continue;
    if (operation === "media" && !parseMedia(text)) continue; // the shape matched but no action resolves
    return { operation, rule };
  }
  return undefined;
}
