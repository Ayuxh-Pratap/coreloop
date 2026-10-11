/**
 * A simulated desktop surface: the stand-in the core is tested, evaluated and demonstrated on. It keeps
 * open windows in Z-order (top first), which one is in front, and which are minimized, and every plan it runs
 * changes that state the way a real desktop would: opening Spotify puts it on top, so the next command of a
 * conversation is judged in Spotify. Nothing here touches the real machine.
 *
 * `host` models coreloop running inside another app's terminal (Cursor on day 2): its window never counts as the
 * app in use, and after every turn it takes the focus back, as when the user glances at coreloop's output.
 */
import type { AppEntry } from "../core/apps.ts";
import { ALL_COMMON } from "../core/operations.ts";
import type { Skill, SkillAction } from "../skills/types.ts";
import { PlanError, type Assume, type Decided, type Plan, type Receipt, type Surface, type SurfaceView } from "../surface/contract.ts";
import { SIM_SKILLS } from "./skills.ts";
import { toHref } from "./url.ts";

export { toHref };

export interface SimWindow {
  hwnd: number;
  /** Process name without .exe, e.g. "Spotify", "Code", "WindowsTerminal". */
  process: string;
  title: string;
  minimized?: boolean;
}

export interface SimSpec {
  /** Names of the apps open at the start, top of the Z-order first. */
  open?: string[];
  /** Which of them is in front (moved to the top). */
  foreground?: string;
  /** The app whose terminal runs coreloop: never the app in use, and it takes the focus back after every turn. */
  host?: string;
}

/** A step the simulator runs. Words in `type`/`paste` are always spans of the user's own words. */
export type SimStep =
  | { do: "launch"; app: string }
  | { do: "focus"; hwnd: number; title: string }
  | { do: "close"; hwnd: number; title: string }
  | { do: "window"; hwnd: number; title: string; show: "maximize" | "minimize" | "restore" }
  | { do: "keys"; keys: string[] }
  | { do: "type" | "paste"; text: string }
  | { do: "open"; url: string }
  | { do: "act"; id: string; app?: string }
  | { do: "wait"; ms: number };

/** Process names of apps whose window title doesn't contain the app name. */
const PROCESS: Readonly<Record<string, string>> = {
  "Visual Studio Code": "Code",
  "Google Chrome": "chrome",
  Terminal: "WindowsTerminal",
  Calculator: "CalculatorApp",
  "File Explorer": "explorer",
  "Microsoft Edge": "msedge",
  Claude: "claude",
  "OBS Studio": "obs64",
  Brave: "brave",
};

const processOf = (app: string) => (PROCESS[app] ?? app.replace(/\s+/g, "")).toLowerCase();

/** The open window that belongs to an app: by process name, else by the app name in the title. */
export function findWindow(app: string, windows: readonly SimWindow[]): SimWindow | undefined {
  const proc = processOf(app);
  return windows.find((w) => w.process.toLowerCase() === proc) ?? windows.find((w) => w.title.toLowerCase().includes(app.toLowerCase()));
}

/** The app a window belongs to: by process name first, so a Chrome tab titled "Claude" is still Chrome. */
export function appOfWindow(w: SimWindow, apps: readonly AppEntry[]): string | undefined {
  const proc = w.process.toLowerCase();
  const byProcess = apps.find((a) => processOf(a.name) === proc);
  if (byProcess) return byProcess.name;
  const title = w.title.toLowerCase();
  return apps.filter((a) => title.includes(a.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0]?.name;
}

const MEDIA_KEYS: Readonly<Record<string, string>> = {
  play_pause: "media_play_pause",
  next: "media_next",
  previous: "media_previous",
  volume_up: "volume_up",
  volume_down: "volume_down",
  mute: "volume_mute",
};
const MEDIA_UNDO: Readonly<Record<string, string>> = { media_play_pause: "media_play_pause", media_next: "media_previous", media_previous: "media_next", volume_up: "volume_down", volume_down: "volume_up", volume_mute: "volume_mute" };

const SEARCH_URL = "https://www.google.com/search?q=";

interface State {
  windows: readonly SimWindow[];
  foreground?: SimWindow;
  /** The window the user is working in (not the host, not minimized). */
  target?: SimWindow;
}

const ORDINAL = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** What doing a skill action looks like: its `does` line with the slots filled in, else "<label> in <app>". */
function describeAction(label: string, does: string | undefined, slots: Record<string, unknown>, app: string | undefined): string {
  // a position ({choice}) reads as a word: "the second song", "the last song" (-1)
  const word = (k: string, v: unknown) => (k === "choice" && typeof v === "number" ? (v === -1 ? "last" : (ORDINAL[v - 1] ?? String(v))) : v);
  if (does) return does.replace(/\{(\w+)\}/g, (_, k: string) => String((k === "app" ? app : word(k, slots[k])) ?? ""));
  return app ? `${label} in ${app}` : label;
}

export class SimDesktop implements Surface {
  readonly name = "simulated desktop";
  readonly apps: readonly AppEntry[];
  readonly skills: readonly Skill[];
  /** A desktop does every common operation. */
  readonly operations: readonly string[] = ALL_COMMON;
  /** Its own actions by id: a surface looks up what it declared, it doesn't need the engine's skill set. */
  private readonly actions: ReadonlyMap<string, { skill: Skill; action: SkillAction }>;
  /** Top of the Z-order first. */
  windows: SimWindow[] = [];
  foreground: SimWindow | undefined;
  readonly host: string | undefined;
  /** Every step run, in order. */
  readonly log: SimStep[] = [];
  private nextHwnd = 5000;

  constructor(apps: readonly AppEntry[], spec: SimSpec = {}, skills: readonly Skill[] = SIM_SKILLS) {
    this.apps = apps;
    this.skills = skills;
    this.actions = new Map(skills.flatMap((skill) => skill.actions.map((action) => [action.id, { skill, action }] as const)));
    this.host = spec.host;
    for (const name of spec.open ?? []) this.windows.push(this.window(name));
    if (spec.foreground) this.toTop(findWindow(spec.foreground, this.windows));
  }

  /** A desktop from fixture windows (eval/windows.json) instead of app names. */
  static fromWindows(apps: readonly AppEntry[], windows: readonly SimWindow[], foreground?: SimWindow, skills?: readonly Skill[]): SimDesktop {
    const sim = new SimDesktop(apps, {}, skills);
    sim.windows = windows.map((w) => ({ ...w }));
    sim.foreground = foreground && sim.windows.find((w) => w.hwnd === foreground.hwnd);
    return sim;
  }

  private window(app: string): SimWindow {
    return { hwnd: this.nextHwnd++, process: PROCESS[app] ?? app.replace(/\s+/g, ""), title: app };
  }

  private toTop(w: SimWindow | undefined): void {
    if (!w) return;
    this.windows = [w, ...this.windows.filter((x) => x.hwnd !== w.hwnd)];
    this.foreground = w;
  }

  private isHost(w: SimWindow): boolean {
    return this.host !== undefined && w.process.toLowerCase() === processOf(this.host);
  }

  private state(): State {
    const usable = (w: SimWindow) => !this.isHost(w) && !w.minimized;
    const fg = this.foreground;
    const target = fg && usable(fg) ? fg : this.host ? this.windows.find(usable) : fg;
    return { windows: this.windows, foreground: fg, target };
  }

  async view(): Promise<SurfaceView> {
    const { target } = this.state();
    const open = [...new Set(this.windows.map((w) => appOfWindow(w, this.apps)).filter((a): a is string => Boolean(a)))];
    const at = target ? appOfWindow(target, this.apps) : undefined;
    return { places: this.apps, path: at ? [at] : [], open };
  }

  /** End of a turn: the host app (if any) takes the focus back. */
  afterTurn(): void {
    if (this.host) this.toTop(findWindow(this.host, this.windows));
  }

  plan(action: Decided, assume: Assume = {}): Plan {
    let st = this.state();
    // the desktop's own place on the path: the outermost one it knows
    const inUse = assume.path?.find((p) => this.apps.some((a) => a.name === p));
    if (inUse) {
      // the second half of "open X and …": plan as if X were already in front (its window may still be opening)
      const w = findWindow(inUse, st.windows) ?? { hwnd: -1, process: PROCESS[inUse] ?? inUse.replace(/\s+/g, ""), title: inUse };
      st = { windows: st.windows.includes(w) ? st.windows : [w, ...st.windows], foreground: w, target: w };
    }
    return this.planIn(action, st);
  }

  private showApp(app: string, appId: string | undefined, st: State): Plan {
    const w = findWindow(app, st.windows);
    if (w) return { summary: `bring ${app} to the front`, detail: [`focus "${w.title}"`], shows: app, data: [{ do: "focus", hwnd: w.hwnd, title: w.title }] satisfies SimStep[] };
    if (!appId && !this.apps.some((a) => a.name === app)) throw new PlanError(`${app} isn't installed`);
    return { summary: `launch ${app}`, detail: [`launch ${app}`], shows: app, data: [{ do: "launch", app }] satisfies SimStep[] };
  }

  /** Steps that make sure an app is in front before keys go to it: none if it already is. */
  private inFront(app: string, st: State): SimStep[] {
    if (st.foreground && appOfWindow(st.foreground, this.apps) === app) return [];
    const show = this.showApp(app, undefined, st).data as SimStep[];
    return [...show, { do: "wait", ms: show[0]!.do === "launch" ? 3000 : 300 }];
  }

  private planIn(action: Decided, st: State): Plan {
    const { operation, slots } = action;
    const make = (summary: string, steps: SimStep[], shows?: string): Plan => ({ summary, detail: steps.map(stepText), shows, data: steps, undo: this.undoFor(steps, st) });
    switch (operation) {
      case "open_app":
      case "focus_app": {
        const p = this.showApp(slots.app!, slots.app_id, st);
        return { ...p, undo: this.undoFor(p.data as SimStep[], st) };
      }
      case "close_app": {
        const w = slots.window === "current" ? (st.target ?? st.foreground) : findWindow(slots.app!, st.windows);
        if (!w) throw new PlanError(slots.window === "current" ? "no window is in front" : `${slots.app} isn't open`);
        return make(`close "${w.title}"`, [{ do: "close", hwnd: w.hwnd, title: w.title }]);
      }
      case "claude.prompt": {
        const text = slots.span!;
        if (slots.claude_target === "terminal") {
          return make(`open Claude Code in a terminal and paste "${text}" (not sent)`, [{ do: "launch", app: "Terminal" }, { do: "wait", ms: 3500 }, { do: "paste", text }], "Terminal");
        }
        const show = this.showApp("Claude", undefined, st);
        const steps = show.data as SimStep[];
        return make(`${show.summary} and paste "${text}" (not sent)`, [...steps, { do: "wait", ms: steps[0]!.do === "launch" ? 3000 : 400 }, { do: "paste", text }], "Claude");
      }
      case "paste_text":
      case "type_text": {
        // into the app the user named, if any; Enter only for "… and send", which was confirmed by voice first
        const into = slots.app ? this.inFront(slots.app, st) : [];
        const verb = operation === "paste_text" ? "paste" : "type";
        const send: SimStep[] = slots.submit ? [{ do: "wait", ms: 150 }, { do: "keys", keys: ["enter"] }] : [];
        return make(`${verb} "${slots.span}"${slots.app ? ` in ${slots.app}` : ""}${slots.submit ? " and press Enter" : ""}`, [...into, { do: verb, text: slots.span! }, ...send], slots.app);
      }
      case "press_key":
        return make(`press ${slots.key}`, [{ do: "keys", keys: [slots.key!] }]);
      case "media":
        return make(`media: ${slots.media}`, [{ do: "keys", keys: [MEDIA_KEYS[slots.media!]!] }]);
      case "open_url": {
        const href = toHref(slots.url!);
        if (!href) throw new PlanError(`not a URL I can open: ${slots.url}`);
        return make(`open ${href}`, [{ do: "open", url: href }]);
      }
      case "search_web":
        return make(`search for "${slots.span}"`, [{ do: "open", url: SEARCH_URL + encodeURIComponent(slots.span!) }]);
      case "confirm":
      case "cancel":
        return { summary: `${operation} (nothing was waiting)`, detail: [], data: [] };
      default:
        return this.planSkill(action, st);
    }
  }

  private planSkill(action: Decided, st: State): Plan {
    const { operation, slots } = action;
    const entry = this.actions.get(operation);
    if (!entry) throw new PlanError(`no executor for ${operation}`);
    const steps = (s: SimStep[]): Plan => ({ summary: "", detail: s.map(stepText), data: s, undo: this.undoFor(s, st) });

    if (entry.skill.id === "window") {
      if (operation === "window.show_desktop") return { ...steps([{ do: "keys", keys: ["lwin", "d"] }]), summary: "show the desktop" };
      const w = slots.app ? findWindow(slots.app, st.windows) : (st.target ?? st.foreground);
      if (!w) throw new PlanError(slots.app ? `${slots.app} isn't open` : "no window is in front");
      if (operation === "window.snap") {
        const front: SimStep[] = st.foreground?.hwnd === w.hwnd ? [] : [{ do: "focus", hwnd: w.hwnd, title: w.title }, { do: "wait", ms: 300 }];
        return { ...steps([...front, { do: "keys", keys: ["lwin", slots.kind === "left" ? "left" : "right"] }]), summary: `snap "${w.title}" to the ${slots.kind}` };
      }
      const how = operation === "window.maximize" ? "maximize" : operation === "window.minimize" ? "minimize" : "restore";
      return { ...steps([{ do: "window", hwnd: w.hwnd, title: w.title, show: how }]), summary: `${how} "${w.title}"` };
    }

    const app = slots.app ?? entry.skill.places[0];
    const shows = entry.action.shows !== false && app ? app : undefined;
    const front = shows ? this.inFront(shows, st) : [];
    const plan = steps([...front, { do: "act", id: operation, app }]);
    return { ...plan, summary: describeAction(entry.action.label, entry.action.does, slots as Record<string, unknown>, app), shows };
  }

  /** The safe reverse of some steps: back to the window that was in front, or the opposite media key. Else none. */
  private undoFor(steps: readonly SimStep[], st: State): Plan | undefined {
    const before = st.target;
    if (steps.length && steps.every((s) => s.do === "focus") && before) {
      const back: SimStep[] = [{ do: "focus", hwnd: before.hwnd, title: before.title }];
      return { summary: `bring "${before.title}" back to the front`, detail: back.map(stepText), data: back };
    }
    const only = steps.length === 1 ? steps[0]! : undefined;
    if (only?.do === "keys" && only.keys.length === 1 && MEDIA_UNDO[only.keys[0]!]) {
      const back: SimStep[] = [{ do: "keys", keys: [MEDIA_UNDO[only.keys[0]!]!] }];
      return { summary: `undo: ${MEDIA_UNDO[only.keys[0]!]!.replace(/_/g, " ")}`, detail: back.map(stepText), data: back };
    }
    return undefined;
  }

  async run(plan: Plan): Promise<Receipt> {
    for (const step of (plan.data ?? []) as SimStep[]) this.apply(step);
    return { ok: true };
  }

  private apply(step: SimStep): void {
    this.log.push(step);
    if (step.do === "launch") {
      this.toTop(findWindow(step.app, this.windows) ?? this.window(step.app));
    } else if (step.do === "focus") {
      // focusing a minimized window restores it
      const w = this.windows.find((x) => x.hwnd === step.hwnd);
      this.toTop(w && { ...w, minimized: false });
    } else if (step.do === "window") {
      const w = this.windows.find((x) => x.hwnd === step.hwnd);
      if (w && step.show === "minimize") {
        this.windows = [...this.windows.filter((x) => x !== w), { ...w, minimized: true }];
        this.foreground = this.windows[0];
      } else if (w) this.toTop({ ...w, minimized: false });
    } else if (step.do === "close") {
      this.windows = this.windows.filter((w) => w.hwnd !== step.hwnd);
      if (this.foreground?.hwnd === step.hwnd) this.foreground = this.windows[0];
    } else if (step.do === "act" && step.app) {
      // a skill action that shows its app (browsers open a tab, Spotify navigates…)
      const entry = this.actions.get(step.id);
      if (entry && entry.action.shows !== false) this.toTop(findWindow(step.app, this.windows) ?? this.window(step.app));
    }
  }
}

/** One step in words, as dry runs and the map show it. */
export function stepText(s: SimStep): string {
  switch (s.do) {
    case "launch":
      return `launch ${s.app}`;
    case "focus":
      return `focus "${s.title}"`;
    case "close":
      return `close "${s.title}"`;
    case "window":
      return `${s.show} "${s.title}"`;
    case "keys":
      return `keys ${s.keys.join("+")}`;
    case "type":
    case "paste":
      return `${s.do} ${JSON.stringify(s.text)} (no Enter)`;
    case "open":
      return `open ${s.url}`;
    case "act":
      return `${s.id}${s.app ? ` in ${s.app}` : ""}`;
    case "wait":
      return `wait ${s.ms} ms`;
  }
}
