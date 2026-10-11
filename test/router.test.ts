import { describe, expect, it } from "vitest";
import type { SystemOneClient } from "../src/backends/systemone.ts";
import { matchApps } from "../src/core/apps.ts";
import { itemsFor, matchItem, saysLabel, type Item } from "../src/core/items.ts";
import { Actor } from "../src/live/actor.ts";
import { oneLinkPerPlace, SimBrowser } from "../src/sim/browser.ts";
import { loadPages } from "../src/sim/fixture.ts";
import { fixtureDesktop } from "../src/sim/fixture.ts";
import { SkillError, parseSkills } from "../src/skills/validate.ts";
import { Surfaces } from "../src/surface/router.ts";

const pages = loadPages();
const noModel = {
  decide: () => {
    throw new Error("model called");
  },
} as unknown as SystemOneClient;

/** The simulated desktop with the simulated browser inside Brave. */
function both(page: string, foreground = "Brave") {
  const desktop = fixtureDesktop({ open: ["Brave", "Visual Studio Code", "Terminal", "Spotify"], foreground });
  const browser = new SimBrowser(pages, page, "Brave");
  const surfaces = new Surfaces([desktop, browser]);
  const actor = new Actor({ client: noModel, surface: surfaces });
  const via = async (said: string) => {
    const r = await actor.handle(said);
    surfaces.afterTurn();
    const i = (r.plan?.data as { via?: number } | undefined)?.via;
    return { r, surface: i === undefined ? undefined : surfaces.surfaces[i]!.name };
  };
  return { desktop, browser, surfaces, via };
}

describe("several surfaces at once", () => {
  it("merges what they see: one entry per place with every alias, a path chained by containment, items tagged with their place", async () => {
    const { surfaces } = both("example");
    const v = await surfaces.view();
    expect(v.path).toEqual(["Brave", "example.com"]);
    expect(v.places.filter((a) => a.name === "Brave")).toHaveLength(1);
    expect(v.places.find((a) => a.name === "Brave")!.aliases).toContain("the browser");
    expect(v.items?.every((i) => i.app === "Brave")).toBe(true);
    expect(itemsFor(v.items, "Spotify")).toBeUndefined();
  });

  it("an inner surface's name is its own: 'the browser' is Brave when its surface is connected, not the desktop's Chrome", async () => {
    const v = await both("example").surfaces.view();
    expect(matchApps("the browser", v.places)[0]!.app.name).toBe("Brave");
    expect(v.places.find((a) => a.name === "Google Chrome")!.aliases).not.toContain("the browser");
    expect(v.places.find((a) => a.name === "Google Chrome")!.aliases).toContain("chrome");
    // the desktop alone still says Chrome
    const alone = await fixtureDesktop().view();
    expect(matchApps("the browser", alone.places)[0]!.app.name).toBe("Google Chrome");
  });

  it("sends each action to the surface that can carry it out", async () => {
    const { via, browser } = both("search-results");
    expect((await via("click the first result")).surface).toBe("simulated browser");
    expect(browser.page.url).toBe("https://typesafe.ai/jev");
    expect((await via("mute")).surface).toBe("simulated desktop");
    expect((await via("open spotify")).surface).toBe("simulated desktop");
    expect((await via("switch to brave")).surface).toBe("simulated desktop");
    expect((await via("search for next.js")).surface).toBe("simulated browser");
  });

  it("acts in the browser when it's named, from another app", async () => {
    const { via } = both("ddg-lumen", "Spotify");
    const click = await via("click the first result in the browser");
    expect(click.surface).toBe("simulated browser");
    const search = await via("search for lumen caching on brave");
    expect(search.r.outcome).toMatchObject({ decision: "act", operation: "search_web", slots: { app: "Brave" } });
    expect(search.surface).toBe("simulated browser");
  });

  it("a site search named anywhere opens in the browser and brings it up", async () => {
    const { via } = both("example", "Visual Studio Code");
    const r = await via("search youtube for lofi beats");
    expect(r.surface).toBe("simulated browser");
    expect(r.r.plan?.shows).toBe("Brave");
    expect((await via("click the first video")).r.outcome).toMatchObject({ operation: "page.click", slots: { item: "e36" } });
  });

  it("asks when an installed app and a link on the page have the same name", async () => {
    const { via } = both("localhost-dashboard");
    const r = await via("open settings");
    expect(r.r.outcome.decision).toBe("ask");
    expect(r.r.outcome.decision === "ask" && r.r.outcome.choices?.map((c) => c.operation)).toEqual(["page.click", "open_app"]);
  });
});

describe("items said the everyday way", () => {
  const issues = pages["github-issues"]!.items;
  const mdn = pages["docs-array-map"]!.items;

  it("lets the rare word decide", () => {
    expect(matchItem("closed issues", issues)?.label).toMatch(/^Closed/);
  });

  it("joins words said apart, counting every word they cover", () => {
    expect(matchItem("flat map", mdn)?.label).toBe("flatMap()");
    expect(matchItem("devs for devs one", oneLinkPerPlace(pages["ddg-lumen"]!.items))?.label).toMatch(/DevsForDevs/);
  });

  it("clicks a button or a place said on its own", () => {
    expect(saysLabel("new issue", issues)?.label).toBe("New issue");
    expect(saysLabel("copy the install command", pages["npm-lumen"]!.items)?.label).toBe("Copy install command line");
    expect(saysLabel("the third result", oneLinkPerPlace(pages["ddg-lumen"]!.items))?.label).toMatch(/Step-by-Step/);
    expect(saysLabel("next song", pages["youtube-lofi"]!.items)).toBeUndefined();
  });

  it("folds a result's URL line and snippet into it, and keeps other links apart", () => {
    const ddg = oneLinkPerPlace(pages["ddg-lumen"]!.items);
    expect(ddg.filter((i) => i.href === "lumen.example.com/docs/routing/getting-started")).toHaveLength(1);
    const repo = oneLinkPerPlace(pages["github-repo"]!.items);
    expect(repo.some((i) => i.label === "Fork 33.9k")).toBe(true);
  });

  it("never matches page links by sound", () => {
    const links: Item[] = [{ id: "a", label: "Security", role: "link" }];
    expect(matchItem("second", links)).toBeUndefined();
  });
});

describe("skills that say how they're used", () => {
  it("accepts byLabel and handles, and refuses handles that aren't common operations", () => {
    const action = { id: "p.click", label: "click", what: "click", risk: "safe", templates: ["click {item}"], slots: { item: "item" }, byLabel: true };
    expect(parseSkills([{ id: "p", places: ["X"], handles: ["search_web"], actions: [action] }])).toHaveLength(1);
    expect(() => parseSkills([{ id: "p", places: ["X"], handles: ["fly"], actions: [action] }])).toThrow(SkillError);
  });
});
