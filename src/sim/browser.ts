/**
 * A simulated browser surface: pages with items (links, buttons, fields), history, scroll and tabs, for
 * testing how the core picks among many items. The pages are snapshots ported from the browser prototype
 * (`eval/browser/pages.json`, from ../jev-voice-browser's test fixtures), so its 34 integration cases can run on the
 * core. Nothing here touches a real browser; that surface comes later on its own branch.
 *
 * What the browser does, it declares as data (the `page` skill below); the common operations it supports are
 * opening a URL, searching, typing, pasting and pressing a key, but not opening or closing apps.
 */
import type { Item } from "../core/items.ts";
import type { Skill, SkillAction } from "../skills/types.ts";
import { PlanError, type Assume, type Decided, type Plan, type Receipt, type Surface, type SurfaceView } from "../surface/contract.ts";
import { toHref } from "./url.ts";

export interface PageItem extends Item {
  /** Where a link goes, without the scheme. */
  href?: string;
}

export interface Page {
  url: string;
  title: string;
  /** The item to type a search into, when the page has a search box. */
  searchBox?: string;
  items: PageItem[];
}

/** A step the simulated browser runs. Typed words are always spans of the user's own words. */
export type BrowserStep =
  | { do: "navigate"; url: string }
  | { do: "click"; item: string; label: string }
  | { do: "type"; item?: string; text: string; submit?: boolean }
  | { do: "key"; key: string }
  | { do: "scroll"; direction: string; amount: string }
  | { do: "back" | "forward" | "reload" | "tab_new" | "tab_close" | "tab_next" | "tab_previous" };

/** Searching a named site ("search youtube for lofi beats"). */
const SITE_SEARCH: Readonly<Record<string, string>> = {
  "youtube.com": "https://www.youtube.com/results?search_query=",
  "wikipedia.org": "https://en.wikipedia.org/w/index.php?search=",
  "github.com": "https://github.com/search?q=",
  "google.com": "https://www.google.com/search?q=",
  "amazon.com": "https://www.amazon.com/s?k=",
  "reddit.com": "https://www.reddit.com/search/?q=",
};
const ENGINE = "https://duckduckgo.com/?q=";

const keys = (id: string, label: string, what: string, templates: string[], risk: SkillAction["risk"] = "safe"): SkillAction => ({ id, label, what, risk, templates, shows: false });

/** What the simulated browser can do, as plain data. */
export const PAGE: Skill = {
  id: "page",
  places: ["Browser"],
  handles: ["open_url", "search_web", "type_text", "paste_text", "press_key"],
  actions: [
    {
      id: "page.scroll",
      label: "scroll",
      what: "scroll the page up or down (scroll down a bit, to the bottom)",
      risk: "safe",
      templates: [
        { t: "scroll [down] (a bit|a little|slightly|a little bit)", set: { direction: "down", amount: "little" } },
        { t: "scroll [all the way] [down] to the (bottom|end)", set: { direction: "down", amount: "end" } },
        { t: "scroll up (a bit|a little|slightly|a little bit)", set: { direction: "up", amount: "little" } },
        { t: "scroll [all the way] [up] to the top", set: { direction: "up", amount: "end" } },
        { t: "[go] [all the way] (back|up) to the top", set: { direction: "up", amount: "end" } },
        { t: "scroll up", set: { direction: "up", amount: "page" } },
        { t: "page up", set: { direction: "up", amount: "page" } },
        { t: "go up", set: { direction: "up", amount: "page" } },
        { t: "scroll [down]", set: { direction: "down", amount: "page" } },
        { t: "page down", set: { direction: "down", amount: "page" } },
        { t: "go down", set: { direction: "down", amount: "page" } },
      ],
      does: "scroll {direction} ({amount})",
      shows: false,
    },
    {
      id: "page.search_site",
      label: "search a site",
      what: "search a named site for something (search youtube for lofi beats)",
      risk: "safe",
      templates: ["search {site} for {query}", "search [for] {query} on {site}"],
      // names its site itself, so it works from any app ("search youtube for lofi" in the editor)
      anywhere: ["search {site} for {query}"],
      slots: { site: "site", query: "search" },
      does: 'search {url} for "{query}"',
      shows: false,
    },
    keys("page.back", "go back", "go back to the previous page (go back, back to the results)", ["[go] back [a page|one page]", "go back to [the] *", "previous page"]),
    keys("page.forward", "go forward", "go forward a page (go forward)", ["[go] forward [a page|one page]", "next page"]),
    keys("page.reload", "reload the page", "reload the page (refresh, reload this page)", ["(reload|refresh) [the|this] [page|tab|site]"]),
    keys("page.tab_new", "open a new tab", "open a new tab (new tab, open a tab)", ["[open|create|make|give me] [a] new tab", "open a tab"]),
    keys("page.tab_close", "close this tab", "close the current tab (close this tab)", ["(close|shut) [this|the|that|current] tab"], "confirm"),
    keys("page.tab_next", "go to the next tab", "switch to the next tab (next tab)", ["[go to|switch to] [the] next tab", "next tab"]),
    keys("page.tab_previous", "go to the previous tab", "switch to the previous tab (previous tab)", ["[go to|switch to] [the] (previous|last) tab", "(previous|last) tab"]),
    // last: "open {item}" would otherwise take "open a new tab" and "go back to the results"
    {
      id: "page.click",
      label: "click it",
      what: "click or open a link, button or result on the page (click sign in, open the comments, the first result)",
      risk: "safe",
      templates: [
        "(click|press|tap|hit|select|choose|pick) [on] [the] {item}",
        "(open|go to|visit|show me|jump to|take me to|navigate to) [the] {item}",
        "(play|watch) [the] {item}",
      ],
      slots: { item: "item" },
      does: 'click "{item_label}"',
      shows: false,
      byLabel: true,
    },
    {
      id: "page.type_into",
      label: "type into it",
      what: "type the user's words into a box or field on the page (type hello into the search box)",
      risk: "fill",
      templates: ["(type|enter|write|put|fill in) {span} (into|in|on) [the] {item}"],
      slots: { item: "item" },
      does: 'type "{span}" into "{item_label}"',
      example: '"type hello into the search box"',
      shows: false,
    },
  ],
};

const bare = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");
/** "localhost:3000", "news.ycombinator.com": the place a page is on. */
export const siteOf = (url: string): string | undefined => /^(?:https?:\/\/)?([^/?#]+)/.exec(url)?.[1]?.replace(/^www\./, "");
const pathOf = (url: string) => bare(url.replace(/[?#].*$/, ""));

/** "duckduckgo.com/?q=a+b" and "html.duckduckgo.com/html/?q=a%20b" are the same search: site and query. */
function searchOf(url: string): { site: string; query: string } | undefined {
  try {
    const u = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`);
    const q = u.searchParams.get("q") ?? u.searchParams.get("search_query") ?? u.searchParams.get("search");
    return q ? { site: u.hostname.replace(/^(?:www|html|en)\./, ""), query: q.toLowerCase().trim() } : undefined;
  } catch {
    return undefined;
  }
}

export class SimBrowser implements Surface {
  readonly name = "simulated browser";
  readonly skills: readonly Skill[];
  /** The app it lives in: "Brave" next to the simulated desktop, "Browser" on its own. */
  readonly app: string;
  /** Contract v2: it lives inside that app on the desktop. */
  get inside(): string {
    return this.app;
  }
  readonly operations = ["open_url", "search_web", "type_text", "paste_text", "press_key"];
  private readonly pages: Record<string, Page>;
  page: Page;
  private readonly history: Page[] = [];
  private readonly ahead: Page[] = [];
  tabs = 1;
  /** Every step run, in order. */
  readonly log: BrowserStep[] = [];

  constructor(pages: Record<string, Page>, start: string, app = "Browser") {
    this.pages = pages;
    this.app = app;
    this.skills = [{ ...PAGE, places: [app] }];
    const p = pages[start];
    if (!p) throw new Error(`no page "${start}"`);
    this.page = p;
  }

  /**
   * A known page for a URL, else an empty one (the simulation only knows its snapshots). A search lands on the
   * snapshot of that search's results on the same site, however the URL spells the query.
   */
  private pageAt(url: string): Page {
    const target = bare(url);
    const search = searchOf(url);
    const found = Object.values(this.pages).find((p) => {
      if (bare(p.url) === target) return true;
      const s = searchOf(p.url);
      return Boolean(search && s && s.site === search.site && s.query === search.query);
    });
    // a tab or an anchor on the same page ("?activeTab=versions", "#examples") stays on that page
    const samePage = !search ? Object.values(this.pages).find((p) => !searchOf(p.url) && pathOf(p.url) === pathOf(url)) : undefined;
    return found ?? samePage ?? { url: `https://${target}`, title: target, items: [] };
  }

  async view(): Promise<SurfaceView> {
    // where I am: the browser, then the site of the page in front (a web app of mine on that site nests under it)
    const site = siteOf(this.page.url);
    return {
      places: [{ name: this.app, id: this.app, kind: "app", aliases: ["browser", "the browser", "web browser"] }],
      path: site ? [this.app, site] : [this.app],
      open: [this.app],
      items: oneLinkPerPlace(this.page.items),
    };
  }

  plan(action: Decided): Plan {
    const { operation, slots } = action;
    // going somewhere brings the browser to the front, when a page was asked for from another app
    const make = (summary: string, steps: BrowserStep[], undo?: Plan): Plan => ({
      summary,
      detail: steps.map(stepText),
      data: steps,
      undo,
      ...(steps.some((s) => s.do === "navigate" || s.do === "click" || (s.do === "type" && s.submit)) ? { shows: this.app } : {}),
    });
    const back = make("go back", [{ do: "back" }]);
    const item = (id: unknown) => {
      const it = this.page.items.find((i) => i.id === id);
      if (!it) throw new PlanError(`that isn't on this page any more`);
      return it;
    };
    switch (operation) {
      case "open_url": {
        const href = toHref(String(slots.url));
        if (!href) throw new PlanError(`not a URL I can open: ${slots.url}`);
        return make(`open ${href}`, [{ do: "navigate", url: href }], back);
      }
      case "search_web": {
        const q = String(slots.span);
        if (this.page.searchBox) return make(`search this site for "${q}"`, [{ do: "type", item: this.page.searchBox, text: q, submit: true }], back);
        return make(`search for "${q}"`, [{ do: "navigate", url: ENGINE + encodeURIComponent(q) }], back);
      }
      case "type_text":
      case "paste_text":
        return make(`type "${slots.span}"`, [{ do: "type", text: String(slots.span) }]);
      case "press_key":
        return make(`press ${slots.key}`, [{ do: "key", key: String(slots.key) }]);
      case "confirm":
      case "cancel":
        return { summary: `${operation} (nothing was waiting)`, detail: [], data: [] };
      case "page.click": {
        const it = item(slots.item);
        return make(`click "${it.label}"`, [{ do: "click", item: it.id, label: it.label }], it.href ? back : undefined);
      }
      case "page.type_into": {
        const it = item(slots.item);
        return make(`type "${slots.span}" into "${it.label}"`, [{ do: "type", item: it.id, text: String(slots.span) }]);
      }
      case "page.scroll":
        return make(`scroll ${slots.direction} (${slots.amount})`, [{ do: "scroll", direction: String(slots.direction), amount: String(slots.amount) }]);
      case "page.search_site": {
        const host = bare(String(slots.url)).replace(/^www\./, "");
        const base = SITE_SEARCH[host];
        if (!base) throw new PlanError(`I don't know how to search ${host}`);
        const url = base + encodeURIComponent(String(slots.query));
        return make(`search ${host} for "${slots.query}"`, [{ do: "navigate", url }], back);
      }
      case "page.back":
      case "page.forward":
      case "page.reload":
      case "page.tab_new":
      case "page.tab_close":
      case "page.tab_next":
      case "page.tab_previous": {
        const what = operation.slice(5) as "back" | "forward" | "reload" | "tab_new" | "tab_close" | "tab_next" | "tab_previous";
        return make(PAGE.actions.find((a) => a.id === operation)!.label, [{ do: what }]);
      }
      default:
        throw new PlanError(`no executor for ${operation}`);
    }
  }

  async run(plan: Plan): Promise<Receipt> {
    for (const step of (plan.data ?? []) as BrowserStep[]) this.apply(step);
    return { ok: true };
  }

  /** Go to a URL, as a script in the page would (my web app's router). */
  visit(url: string): void {
    this.apply({ do: "navigate", url });
  }

  private go(next: Page): void {
    this.history.push(this.page);
    this.ahead.length = 0;
    this.page = next;
  }

  private apply(step: BrowserStep): void {
    this.log.push(step);
    if (step.do === "navigate") this.go(this.pageAt(step.url));
    else if (step.do === "click") {
      const href = this.page.items.find((i) => i.id === step.item)?.href;
      if (href) this.go(this.pageAt(href));
    } else if (step.do === "type" && step.submit) {
      // a search in the page's own box shows that site's results
      const host = new URL(/^https?:\/\//.test(this.page.url) ? this.page.url : `https://${this.page.url}`).hostname;
      this.go(this.pageAt(`https://${host}/?q=${encodeURIComponent(step.text)}`));
    }
    else if (step.do === "back") {
      const prev = this.history.pop();
      if (prev) {
        this.ahead.push(this.page);
        this.page = prev;
      }
    } else if (step.do === "forward") {
      const next = this.ahead.pop();
      if (next) {
        this.history.push(this.page);
        this.page = next;
      }
    } else if (step.do === "tab_new") this.tabs++;
    else if (step.do === "tab_close") this.tabs = Math.max(0, this.tabs - 1);
  }
}

/**
 * A result is one item, as a real page reader would give it: a search result's title, its URL line and its snippet
 * all open the same page, so picking among them is no real choice. Links that go where a grouped item (a result, a
 * video) goes fold into it. Other links that share a place stay apart: logged out, "New issue" and "Fork" both lead
 * to the sign-in page but are different buttons.
 */
export function oneLinkPerPlace(items: readonly PageItem[]): PageItem[] {
  const grouped = new Set(items.filter((i) => i.group && i.href).map((i) => i.href));
  return items.filter((i) => i.group || !i.href || !grouped.has(i.href));
}

/** One step in words, as dry runs and the map show it. */
export function stepText(s: BrowserStep): string {
  switch (s.do) {
    case "navigate":
      return `open ${s.url}`;
    case "click":
      return `click ${s.item} "${s.label}"`;
    case "type":
      return `type ${JSON.stringify(s.text)}${s.item ? ` into ${s.item}` : ""}${s.submit ? " and submit the search" : " (no Enter)"}`;
    case "key":
      return `press ${s.key}`;
    case "scroll":
      return `scroll ${s.direction} (${s.amount})`;
    default:
      return s.do.replace("_", " ");
  }
}
