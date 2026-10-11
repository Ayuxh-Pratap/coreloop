/**
 * A simulated world, built from a spec: the desktop, the browser inside one of its apps, my web app in the browser's
 * tab, or the browser on its own. The conversation evals, the pipeline map's traces and the demo's export all
 * build their surfaces here, so a scenario means the same thing everywhere.
 *
 * It takes the fixtures as data (no files are read here) and copies them, so one world's typing and clicking never
 * leaks into the next.
 */
import type { AppEntry } from "../core/apps.ts";
import type { Surface } from "../surface/contract.ts";
import { Surfaces } from "../surface/router.ts";
import { SimBrowser, type Page } from "./browser.ts";
import { findWindow, SimDesktop, type SimSpec, type SimWindow } from "./desktop.ts";
import { SimWebApp, SITE } from "./webapp.ts";

export interface WorldSpec {
  /**
   * The desktop: "fixture" is eval/windows.json (seven windows, VS Code in front); a spec opens just those apps.
   * Without one, the browser is on its own (the browser eval set).
   */
  desktop?: SimSpec | "fixture";
  /** With the fixture desktop: this app's window comes to the front (a window is made when none is open). */
  front?: string;
  /** The simulated browser on this page (eval/browser/pages.json), inside the desktop app `app` (Brave by default). */
  browser?: { page: string; app?: string };
  /** My web app on localhost:3000 in the browser's tab (the page must be on that site). */
  webapp?: boolean;
  /** false: the engine runs with an empty profile (no mishearings, phrases, nicknames or sites). */
  profile?: boolean;
}

export interface Fixtures {
  apps: readonly AppEntry[];
  pages: Readonly<Record<string, Page>>;
  /** The fixture desktop's windows (eval/windows.json). */
  windows: { windows: SimWindow[]; foreground: SimWindow };
}

export type SimSurface = SimDesktop | SimBrowser | SimWebApp;

export interface World {
  /** What the engine talks to: one surface, or several behind the router. */
  surface: Surface;
  /** Every surface, with the place it lives inside (to connect it over the WebSocket). */
  parts: { surface: SimSurface; inside?: string }[];
  desktop?: SimDesktop;
  browser?: SimBrowser;
  webapp?: SimWebApp;
}

export function buildWorld(spec: WorldSpec, fx: Fixtures): World {
  if (!spec.desktop && !spec.browser) throw new Error("a world needs a desktop or a browser");
  if (spec.webapp && !spec.browser) throw new Error("the web app lives in the browser: give the browser a page");
  if (spec.front && spec.desktop !== "fixture") throw new Error(`"front" is for the fixture desktop; a spec names its own foreground`);
  const parts: World["parts"] = [];
  let desktop: SimDesktop | undefined;
  if (spec.desktop === "fixture") {
    desktop = SimDesktop.fromWindows(fx.apps, fx.windows.windows, fx.windows.foreground);
    if (spec.front) {
      const w = findWindow(spec.front, desktop.windows) ?? { hwnd: 2000, process: spec.front.replace(/\s+/g, ""), title: spec.front };
      desktop.windows = [w, ...desktop.windows.filter((x) => x !== w)];
      desktop.foreground = w;
    }
  } else if (spec.desktop) desktop = new SimDesktop(fx.apps, spec.desktop);
  if (desktop) parts.push({ surface: desktop });
  let browser: SimBrowser | undefined;
  let webapp: SimWebApp | undefined;
  if (spec.browser) {
    if (!fx.pages[spec.browser.page]) throw new Error(`no page "${spec.browser.page}" in the fixtures`);
    const app = desktop ? (spec.browser.app ?? "Brave") : "Browser";
    browser = new SimBrowser(structuredClone(fx.pages) as Record<string, Page>, spec.browser.page, app);
    parts.push({ surface: browser, ...(desktop ? { inside: app } : {}) });
    if (spec.webapp) {
      webapp = new SimWebApp(browser);
      parts.push({ surface: webapp, inside: SITE });
    }
  }
  const surface: Surface = parts.length > 1 ? new Surfaces(parts.map((p) => p.surface)) : parts[0]!.surface;
  return { surface, parts, ...(desktop ? { desktop } : {}), ...(browser ? { browser } : {}), ...(webapp ? { webapp } : {}) };
}

/** Which surface made a plan, by name, when several are connected. */
export function surfaceOf(surface: Surface, data: unknown): string | undefined {
  const via = (data as { via?: unknown } | undefined)?.via;
  return surface instanceof Surfaces && typeof via === "number" ? surface.surfaces[via]!.name : surface.name;
}
