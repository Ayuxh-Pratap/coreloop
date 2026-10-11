/*
 * The common operations: verbs any surface may support, each with rules the core owns (close verbs need a
 * confirm, URL vs app, app names, spans of the user's words). A surface declares which of them it supports
 * (src/surface/contract.ts); the core never decides one it doesn't. confirm / cancel / none are the conversation
 * itself and always there.
 *
 * Each `what` is the option text the model reads: short, contrastive (says what it is NOT for when two are easy
 * to confuse), with an example in the user's words. Every token here costs latency on every request.
 */

/** How risky an action is: `safe` acts; `fill` types the user's words; `confirm` waits for a spoken "confirm"; `never` isn't done by voice. */
export type Risk = "safe" | "fill" | "confirm" | "never";

/** An operation the model can be offered: a common one, or a surface's action. */
export interface Operation {
  /** "open_app", or a skill action's id. */
  id: string;
  /** The option text the model reads. */
  what: string;
  /** Its risk. */
  risk: Risk;
  /** What code must resolve before acting. */
  needs?: "app" | "window" | "span" | "key" | "media" | "url" | "query";
  /** How "what I can do here" says it: "open an app". */
  can?: string;
}

/**
 * The verbs any surface may support. The engine owns their rules (close verbs need a confirm, an address versus an
 * app, typed text is the user's own words) and never decides one a surface didn't declare.
 */
export const COMMON_OPERATIONS: readonly Operation[] = [
  { id: "open_app", what: "open an app by its name (open spotify, start chrome); not a website", risk: "safe", needs: "app", can: "open" },
  { id: "focus_app", what: "switch to an app that is already open (switch to chrome, go back to vs code)", risk: "safe", needs: "window", can: "switch to" },
  { id: "close_app", what: "close or quit an app or window (close spotify, quit chrome)", risk: "confirm", needs: "window", can: "close" },
  { id: "paste_text", what: "paste the user's words where the cursor is (paste hello world)", risk: "fill", needs: "span", can: "paste" },
  { id: "type_text", what: "type the user's words where the cursor is (type hello world)", risk: "fill", needs: "span", can: "type" },
  { id: "press_key", what: "press one key: enter, escape, tab, backspace (press enter)", risk: "safe", needs: "key", can: "press a key" },
  { id: "media", what: "playback or volume: play, pause, next track, volume up, mute", risk: "safe", needs: "media", can: "play/pause/next/volume" },
  { id: "open_url", what: "open a website by name or address (go to youtube, open github dot com)", risk: "safe", needs: "url", can: "open a site" },
  { id: "search_web", what: "search the web (search for X, google X, look up X)", risk: "safe", needs: "query", can: "search the web" },
  { id: "confirm", what: "yes, confirm, do it: approve the action that is waiting", risk: "safe" },
  { id: "cancel", what: "no, cancel, never mind: drop the action that is waiting", risk: "safe" },
  { id: "none", what: "not a command: chit-chat, thinking aloud, or an unfinished fragment", risk: "safe" },
];

/** Always available, whatever the surface: the conversation itself. */
export const CONVERSATION = new Set(["confirm", "cancel", "none", "choose"]);

/** Every common operation a surface could support (all but the conversation). */
export const ALL_COMMON = COMMON_OPERATIONS.filter((o) => !CONVERSATION.has(o.id)).map((o) => o.id);
