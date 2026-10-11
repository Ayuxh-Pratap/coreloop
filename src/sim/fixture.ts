/**
 * The fixture desktop: the installed apps from a real Start menu (eval/apps.json) and seven open windows with
 * VS Code in front (eval/windows.json), as a simulated surface. Evals, the repl, the live loop on main and the
 * pipeline map all run on it, so results never depend on the machine they run on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEntry } from "../core/apps.ts";
import type { Page } from "./browser.ts";
import { SimDesktop, type SimSpec, type SimWindow } from "./desktop.ts";

export function fixtureApps(dir = "eval"): AppEntry[] {
  return JSON.parse(readFileSync(join(dir, "apps.json"), "utf8")) as AppEntry[];
}

/** The simulated browser's page snapshots (eval/browser/pages.json), by name. */
export function loadPages(dir = "eval"): Record<string, Page> {
  return JSON.parse(readFileSync(join(dir, "browser", "pages.json"), "utf8")) as Record<string, Page>;
}

export function fixtureWindows(dir = "eval"): { windows: SimWindow[]; foreground: SimWindow } {
  return JSON.parse(readFileSync(join(dir, "windows.json"), "utf8")) as { windows: SimWindow[]; foreground: SimWindow };
}

/** The fixture desktop, or (with a spec) a desktop with just the named apps open. */
export function fixtureDesktop(spec?: SimSpec, dir = "eval"): SimDesktop {
  const apps = fixtureApps(dir);
  if (spec) return new SimDesktop(apps, spec);
  const { windows, foreground } = fixtureWindows(dir);
  return SimDesktop.fromWindows(apps, windows, foreground);
}
