/**
 * My own web app on localhost, as the npm package would see it (contract v2): a simulated surface that lives in
 * the simulated browser's tab on localhost:3000 (`inside`). It reports:
 *   - its pages and projects as places ("Projects", "Mobile app"), so "open projects" goes to the route;
 *   - where I am in it as a path ("Projects" › "Mobile app"), which the router chains after Brave › localhost:3000;
 *   - the page's items: what the browser reads of the same page, or its own for pages the browser has no snapshot of;
 *   - its own actions as a skill for localhost:3000 (new project, rename, archive, dark mode, click, type).
 * It reads and moves the browser's location, as a script in the page would. Nothing here is a real Next.js app; a
 * real one connects through the npm package, on this contract.
 */
import type { Item } from "../core/items.ts";
import type { Skill, SkillAction } from "../skills/types.ts";
import { PlanError, type Assume, type Decided, type Place, type Plan, type Receipt, type Surface, type SurfaceView } from "../surface/contract.ts";
import { oneLinkPerPlace, siteOf, type SimBrowser } from "./browser.ts";

/** Where my app runs while I develop it. */
export const SITE = "localhost:3000";

interface Route {
  name: string;
  path: string;
  kind: "page" | "project";
  /** The page a project sits under, for the path ("Projects" › "Mobile app"). */
  parent?: string;
  aliases?: string[];
}

export const ROUTES: readonly Route[] = [
  { name: "Dashboard", path: "/dashboard", kind: "page", aliases: ["home", "the dashboard", "home page", "the home page"] },
  { name: "Projects", path: "/projects", kind: "page", aliases: ["all projects", "the projects page", "project list", "the project list"] },
  { name: "Team", path: "/team", kind: "page", aliases: ["the team page", "members"] },
  { name: "Settings", path: "/settings", kind: "page", aliases: ["the settings page", "preferences"] },
  { name: "Docs", path: "/docs", kind: "page", aliases: ["documentation", "the docs"] },
  { name: "Website redesign", path: "/projects/1", kind: "project", parent: "Projects" },
  { name: "Mobile app", path: "/projects/2", kind: "project", parent: "Projects" },
  { name: "API migration", path: "/projects/3", kind: "project", parent: "Projects" },
];

/** Items for the pages the browser has no snapshot of, as my app's own components would report them. */
const OWN_ITEMS: Readonly<Record<string, readonly Item[]>> = {
  "/settings": [
    { id: "s1", label: "Display name", role: "textbox" },
    { id: "s2", label: "Email", role: "textbox" },
    { id: "s3", label: "Password", role: "password" },
    { id: "s4", label: "Theme", role: "select" },
    { id: "s5", label: "Email notifications", role: "switch" },
    { id: "s6", label: "Save changes", role: "button" },
  ],
  "/team": [
    { id: "t1", label: "Invite member", role: "button" },
    { id: "t2", label: "Rahul", role: "link", group: "member" },
    { id: "t3", label: "Sam Carter", role: "link", group: "member" },
    { id: "t4", label: "Remove member", role: "button" },
  ],
  "/docs": [
    { id: "d1", label: "Getting started", role: "link", group: "article" },
    { id: "d2", label: "API reference", role: "link", group: "article" },
    { id: "d3", label: "Deploying", role: "link", group: "article" },
  ],
};

/** A step my app runs. Typed words are always spans of the user's own words. */
export type AppStep =
  | { do: "visit"; url: string }
  | { do: "click"; item: string; label: string }
  | { do: "type"; item: string; text: string }
  | { do: "act"; id: string; slots: Record<string, unknown> };

const act = (id: string, label: string, what: string, templates: SkillAction["templates"], extra: Partial<SkillAction> = {}): SkillAction => ({
  id,
  label,
  what,
  risk: "safe",
  templates,
  shows: false,
  ...extra,
});

/** What my app can do, as the developer declares it to the npm package. */
export const APP_SKILL: Skill = {
  id: "acme",
  places: [SITE],
  actions: [
    act("acme.new_project", "create a project", "create a new project, maybe with a name (new project called billing)", [
      "[create|make|add|start] [a] new project (called|named) {name}",
      "(create|make|add|start) [a] [new] project",
      "new project",
    ]),
    act("acme.rename_project", "rename this project", "rename the project that is open (rename this project to billing)", ["rename [this|the] project to {name}", "change [the] project name to {name}"], {
      risk: "fill",
      example: '"rename this project to billing revamp"',
    }),
    act("acme.archive_project", "archive this project", "archive the project that is open (archive this project)", ["archive [this|the] project"], { risk: "confirm" }),
    act("acme.delete_project", "delete this project", "delete the project that is open (delete this project)", ["(delete|remove) [this|the] project"], { risk: "confirm" }),
    act("acme.theme", "switch dark or light mode", "switch the app between dark and light mode (dark mode, turn on light mode)", [
      { t: "[switch to|turn on|enable|use|go to] dark (mode|theme)", set: { theme: "dark" } },
      { t: "[switch to|turn on|enable|use|go to] light (mode|theme)", set: { theme: "light" } },
      { t: "turn off dark (mode|theme)", set: { theme: "light" } },
    ]),
    // last: "open {item}" would otherwise take the sentences above
    act("acme.click", "click it", "click or open a link, button or field in the app (click save changes, open the second project)", [
      "(click|press|tap|hit|select|choose|pick) [on] [the] {item}",
      "(open|go to|show me|take me to) [the] {item}",
    ], { slots: { item: "item" }, does: 'click "{item_label}"', byLabel: true }),
    act("acme.type_into", "type into it", "type the user's words into a field in the app (type billing into the project name)", ["(type|enter|write|put|fill in) {span} (into|in|on) [the] {item}"], {
      risk: "fill",
      slots: { item: "item" },
      does: 'type "{span}" into "{item_label}"',
    }),
  ],
};

const pathOf = (url: string): string => {
  const p = /^(?:https?:\/\/)?[^/?#]+(\/[^?#]*)?/.exec(url)?.[1] ?? "/";
  return p.length > 1 ? p.replace(/\/$/, "") : "/";
};

export class SimWebApp implements Surface {
  readonly name = "simulated web app";
  readonly inside = SITE;
  readonly skills: readonly Skill[] = [APP_SKILL];
  /** Going to one of its pages; typing and keys stay with the browser. */
  readonly operations = ["open_app", "focus_app"];
  theme: "dark" | "light" = "light";
  /** Every step run, in order. */
  readonly log: AppStep[] = [];
  private readonly browser: SimBrowser;

  constructor(browser: SimBrowser) {
    this.browser = browser;
  }

  /** The page I'm on, when the browser is on my app. */
  private route(): Route | undefined {
    if (siteOf(this.browser.page.url) !== SITE) return undefined;
    const p = pathOf(this.browser.page.url);
    return ROUTES.find((r) => r.path === (p === "/" ? "/dashboard" : p));
  }

  private items(): Item[] {
    const r = this.route();
    if (!r) return [];
    const page = this.browser.page.items;
    return page.length ? oneLinkPerPlace(page) : [...(OWN_ITEMS[r.path] ?? [])];
  }

  async view(): Promise<SurfaceView> {
    const r = this.route();
    const places: Place[] = ROUTES.map((x) => ({ name: x.name, id: x.path, kind: x.kind, ...(x.aliases ? { aliases: x.aliases } : {}) }));
    const items = this.items();
    return { places, path: r ? (r.parent ? [r.parent, r.name] : [r.name]) : [], open: [], ...(items.length ? { items } : {}) };
  }

  plan(action: Decided, _assume?: Assume): Plan {
    const { operation, slots } = action;
    const here = this.route();
    const back = here ? { summary: `go back to ${here.name}`, detail: [`open ${here.name}`], data: [{ do: "visit", url: `${SITE}${here.path}` }] satisfies AppStep[] } : undefined;
    const make = (summary: string, steps: AppStep[], undo?: Plan): Plan => ({ summary, detail: steps.map(stepText), data: steps, ...(undo ? { undo } : {}) });
    switch (operation) {
      case "open_app":
      case "focus_app": {
        const to = ROUTES.find((r) => r.name === slots.app);
        if (!to) throw new PlanError(`${String(slots.app)} isn't a page of this app`);
        return make(`open ${to.name}`, [{ do: "visit", url: `${SITE}${to.path}` }], back);
      }
      case "acme.click": {
        const it = this.items().find((i) => i.id === slots.item);
        if (!it) throw new PlanError("that isn't on this page any more");
        const href = (it as Item & { href?: string }).href;
        return href ? make(`open ${it.label}`, [{ do: "visit", url: href }], back) : make(`click "${it.label}"`, [{ do: "click", item: it.id, label: it.label }]);
      }
      case "acme.type_into":
        return make(`type "${String(slots.span)}" into "${String(slots.item_label)}"`, [{ do: "type", item: String(slots.item), text: String(slots.span) }]);
      case "acme.rename_project":
      case "acme.archive_project":
      case "acme.delete_project": {
        if (here?.kind !== "project") throw new PlanError("open a project first");
        const verb = operation.split(".")[1]!.replace("_project", "");
        const to = slots.name ? ` to "${String(slots.name)}"` : "";
        return make(`${verb} "${here.name}"${to}`, [{ do: "act", id: operation, slots: { ...slots, project: here.name } }]);
      }
      case "acme.new_project":
        return make(slots.name ? `create a project called "${String(slots.name)}"` : "create a new project", [{ do: "act", id: operation, slots }]);
      case "acme.theme":
        return make(`switch to ${String(slots.theme)} mode`, [{ do: "act", id: operation, slots }], {
          summary: `switch back to ${this.theme} mode`,
          detail: [`switch to ${this.theme} mode`],
          data: [{ do: "act", id: operation, slots: { theme: this.theme } }] satisfies AppStep[],
        });
      default:
        throw new PlanError(`my app can't ${operation.replace(/[._]/g, " ")}`);
    }
  }

  async run(plan: Plan): Promise<Receipt> {
    for (const step of (plan.data ?? []) as AppStep[]) {
      this.log.push(step);
      if (step.do === "visit") this.browser.visit(step.url);
      else if (step.do === "act" && step.id === "acme.theme") this.theme = step.slots.theme === "dark" ? "dark" : "light";
    }
    return { ok: true };
  }
}

export function stepText(s: AppStep): string {
  switch (s.do) {
    case "visit":
      return `go to ${s.url}`;
    case "click":
      return `click ${s.item} "${s.label}"`;
    case "type":
      return `type "${s.text}" into ${s.item}`;
    case "act":
      return `${s.id} ${JSON.stringify(s.slots)}`;
  }
}
