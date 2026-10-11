/**
 * The surface contract: the only thing the core knows about the world it acts in. A surface is the Windows
 * desktop, a browser extension, a Next.js app with the npm package, or the simulated desktop the core is tested
 * and demonstrated on. Each one:
 *
 *   view()   says what's there right now: the places the user can name (apps, tabs, routes…), what's open, and
 *            where the user is (a path, outermost first), so "search for X" goes where they are;
 *   inside   the place this surface lives in, on the surface around it ("Brave" for a browser extension,
 *            "localhost:3000" for my web app): paths chain by it, so routing follows containment;
 *   skills   says what it can do, as data (src/skills/types.ts): actions, example sentences, slot kinds, risk;
 *   operations  which common operations it supports (open an app, type, open a URL…; core/operations.ts);
 *   plan()   turns a decided action into the exact steps it would take, without doing anything, so a confirm can
 *            show precisely what will happen and "confirm" runs that same plan;
 *   run()    does it, and reports back.
 *
 * This is contract v2: places and paths instead of apps and one app in use. v1 is gone; no real
 * surface ever used it. In another process the same contract travels as JSON over a loopback WebSocket
 * (src/surface/protocol.ts and client.ts; the core's server belongs to the host, src/host/server.ts); in-process it
 * is called directly.
 *
 * Everything else (speech, normalising, matching names, templates, the model, confirms, questions, repairs,
 * memory, the journal) is the core's, the same for every surface. Window, page and app text a surface reads stays
 * on the surface side: it can be shown to the user, never put into the model's state.
 */
import type { Place } from "../core/apps.ts";
export type { Place } from "../core/apps.ts";
import type { Item } from "../core/items.ts";
import type { Outcome } from "../core/policy.ts";
import type { Skill } from "../skills/types.ts";

/** What a surface sees right now. The engine asks for it once per sentence. */
export interface SurfaceView {
  /** The places the user can name by voice: installed apps on a desktop, a web app's routes, contacts. */
  places: readonly Place[];
  /**
   * Where the user is on this surface, outermost first: ["Spotify"] on a desktop, ["Brave", "localhost:3000"] in a
   * browser. A surface that lives inside another starts its path with that place or right after it. The innermost
   * place is where a command goes when the words don't name one. Empty or missing: nowhere in particular.
   */
  path?: readonly string[];
  /** The places that are open, for words only an open place can mean ("play any Panther song"). */
  open: readonly string[];
  /**
   * The named things where the user is: a page's links, buttons and fields, a chat list's contacts. Labels are
   * untrusted: the engine matches them in code, and offers at most 16 to the model as options, never as its state.
   */
  items?: readonly Item[];
}

/** Plan as if the user were already somewhere: the second half of "open spotify and search for panther". */
export interface Assume {
  /** The path to plan at, outermost first. */
  path?: readonly string[];
}

/** An action the engine decided, ready for a surface to plan: its operation, its details and the reason. */
export type Decided = Extract<Outcome, { decision: "act" | "confirm" }>;

/** The exact steps an action would take. The engine reads only what it shows people; `data` is the surface's own. */
export interface Plan {
  /** One line a person can read: 'close "Spotify Premium"'. */
  summary: string;
  /** The steps in words, for dry runs and the confirm prompt. */
  detail: readonly string[];
  /** The place this brings to the front, so the next command is for it ("open Brave", then "search for X"). */
  shows?: string;
  /** How to reverse it, when that's safe and known ("undo that"). */
  undo?: Plan;
  /** The surface's own steps, for `run()`. Must survive JSON. */
  data?: unknown;
}

/** What running a plan did. */
export interface Receipt {
  /** Whether it worked. */
  ok: boolean;
  /** What the surface had to say ("Playing Panther on Spotify"). Shown to the user, never to the model. */
  notes?: readonly string[];
  /** What went wrong, in words, when `ok` is false. */
  error?: string;
}

/** Thrown by `plan()` when the action can't be carried out as it stands ("Discord isn't open"). The user hears the message, and nothing runs. */
export class PlanError extends Error {}

/**
 * Where actions happen: a desktop, a browser extension, a web app. It says what's there (`view()`), declares what it
 * can do as data (`skills`), and plans and runs decided actions. Planning must change nothing: a destructive plan is
 * shown, held, and run exactly as shown on "confirm".
 */
export interface Surface {
  /** Its name, for logs and replies. */
  readonly name: string;
  /** What it can do, as data. */
  readonly skills: readonly Skill[];
  /** The common operations it supports (`COMMON_OPERATIONS`); the engine never decides any other. Default: all. */
  readonly operations?: readonly string[];
  /** The place it lives in, on the surface around it ("Brave"); none for the outermost (the desktop). */
  readonly inside?: string;
  /** What's there now: places, the path, what's open and the items. */
  view(): Promise<SurfaceView>;
  /** Starts reading the view early, such as when the push-to-talk key is released. Optional. */
  prefetch?(): void;
  /**
   * The exact steps for a decided action, against the last view; nothing runs. `assume.path` plans as if the user
   * were already there (the second half of "open Spotify and search for Panther"). Throws (or rejects with)
   * a `PlanError` when it can't be done. A surface in another process answers asynchronously.
   */
  plan(action: Decided, assume?: Assume): Plan | Promise<Plan>;
  /** Carries out a plan this surface made, exactly as planned. */
  run(plan: Plan): Promise<Receipt>;
  /** The sentence has been handled. Optional. */
  afterTurn?(): void;
}
