/**
 * Fixing the last command by talking to it. A repair edits the previous command instead of starting over:
 *
 *   "no, I meant Claude Code"       name    the misheard name is replaced, the command runs again
 *   "no, search on Brave"           target  same command, another app ("in this window" = the one in front)
 *   "not Panther, Pantera"          swap    one phrase replaced by another
 *   "I meant pantera"               query   the thing looked for, replaced
 *   "I mean change the song"        again   a whole new command in place of the last one
 *   "undo that" / "scratch that"    undo   (also "no, not that one", "wrong link, undo that")
 *   "no, the other one"             other  the last pick among items again, without the item it picked
 *
 * Pure code on the normalised words; the actor applies it to its memory of the last command.
 */
import { APP_NOUNS, HERE_PHRASE, nameApp, type AppEntry } from "./apps.ts";

export type Repair =
  | { kind: "name"; name: string }
  | { kind: "target"; target: string }
  | { kind: "swap"; from: string; to: string }
  | { kind: "query"; query: string }
  | { kind: "again"; text: string }
  | { kind: "undo" }
  | { kind: "other" };

const UNDO =
  /^(?:(?:undo|scratch|revert|reverse) (?:that|this|it|the last one)|undo|(?:no )?not that one|(?:no )?wrong (?:link|one|result|page|button)(?: (?:undo|scratch|revert) (?:that|it)| go back)?)$/;
const OTHER = /^(?:(?:no|nope|not that one|wrong one) )*(?:the )?other (?:one|link|result|button)$/;
const MEANT = /^(?:(?:no|nope|sorry|oops|wait|actually|sorry no|no no) )*(?:i meant|i mean|i said|meant)(?: to)? (.+)$/;
const TARGET = /^(?:(?:no|nope|actually)(?: no)? )*(?:(?:search|do (?:it|that)|play (?:it|that)|open (?:it|that)|try|run (?:it|that))(?: it)? )?(?:on|in|using) (.+?)(?: instead)?$/;
const HERE = new RegExp(`^(?:(?:no|actually) )?(?:(?:do it|search|try|run it) )?(?:here|in (?:${HERE_PHRASE}))(?: instead)?$`);
const APP_NOUN_END = new RegExp(` (?:${APP_NOUNS.join("|")})$`);
const NOT = /^not (.+)$/;

/**
 * How a whole command starts (so "I mean change the song" is a command, "I meant pantera" is not): a common verb,
 * or a word one of the surface's sentences starts with ("I meant click the second link").
 */
const COMMAND =
  /^(?:open|launch|start|run|close|quit|kill|exit|switch|go|bring|put|show|focus|search|google|look|find|play|pause|resume|stop|mute|unmute|next|skip|previous|change|turn|volume|paste|type|write|send|tell|ask|press|hit|like|save|split|new|reload|refresh)\b/;

export function parseRepair(text: string, apps: readonly AppEntry[], hadQuery: boolean, leading: ReadonlySet<string> = new Set()): Repair | undefined {
  if (UNDO.test(text)) return { kind: "undo" };
  if (OTHER.test(text)) return { kind: "other" };
  if (HERE.test(text)) return { kind: "target", target: "here" };

  const meant = MEANT.exec(text)?.[1];
  const target = TARGET.exec(meant ?? text)?.[1];
  if (target && (target === "this window" || target === "here" || nameApp(target.replace(/^the /, "").replace(APP_NOUN_END, ""), apps))) {
    return { kind: "target", target: target.replace(/^the /, "") };
  }
  const not = NOT.exec(text)?.[1];
  if (not) {
    const words = not.split(" ");
    for (let k = words.length - 1; k >= 1; k--) {
      const to = words.slice(k).join(" ").replace(/^(?:but|i meant|i mean) /, "");
      if (to) return { kind: "swap", from: words.slice(0, k).join(" "), to };
    }
  }
  if (!meant) return undefined;
  if (COMMAND.test(meant) || leading.has(meant.split(" ")[0]!)) return { kind: "again", text: meant };
  // After a search, "I meant X" is a new search term unless X is exactly an app's name or alias.
  const app = meant.split(" ").length <= 3 ? nameApp(meant.replace(/^the /, ""), apps) : undefined;
  if (app && (!hadQuery || app.via === "name" || app.via === "alias")) return { kind: "name", name: meant.replace(/^the /, "") };
  if (hadQuery) return { kind: "query", query: meant };
  return { kind: "again", text: meant };
}
