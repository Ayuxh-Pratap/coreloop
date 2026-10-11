// Contract v2: places and paths. Three simulated surfaces: the desktop, the browser inside Brave, and my own
// web app on localhost:3000 in the browser's tab. Paths chain by `inside`, skills apply along the path, and routing
// follows containment.
import { describe, expect, it } from "vitest";
import type { SystemOneClient } from "../src/backends/systemone.ts";
import { matchApps } from "../src/core/apps.ts";
import { Actor } from "../src/live/actor.ts";
import { SimBrowser } from "../src/sim/browser.ts";
import { fixtureDesktop, loadPages } from "../src/sim/fixture.ts";
import { SimWebApp } from "../src/sim/webapp.ts";
import { parseView, ProtocolError } from "../src/surface/protocol.ts";
import { Surfaces } from "../src/surface/router.ts";

const pages = loadPages();
const noModel = {
  decide: () => {
    throw new Error("model called");
  },
} as unknown as SystemOneClient;

function three(foreground = "Brave", page = "localhost-dashboard") {
  const desktop = fixtureDesktop({ open: ["Brave", "Visual Studio Code", "Terminal", "Spotify"], foreground });
  const browser = new SimBrowser(pages, page, "Brave");
  const app = new SimWebApp(browser);
  const surfaces = new Surfaces([desktop, browser, app]);
  const actor = new Actor({ client: noModel, surface: surfaces });
  const via = async (said: string) => {
    const r = await actor.handle(said);
    surfaces.afterTurn();
    const i = (r.plan?.data as { via?: number } | undefined)?.via;
    return { r, surface: i === undefined ? undefined : surfaces.surfaces[i]!.name };
  };
  return { desktop, browser, app, surfaces, via };
}

describe("a path across three surfaces", () => {
  it("chains by containment: Brave › localhost:3000 › my app's page", async () => {
    const v = await three().surfaces.view();
    expect(v.path).toEqual(["Brave", "localhost:3000", "Dashboard"]);
    const project = await three("Brave", "localhost-project").surfaces.view();
    expect(project.path).toEqual(["Brave", "localhost:3000", "Projects", "Mobile app"]);
  });

  it("leaves my app out while another app is in front, and its pages with it", async () => {
    const v = await three("Visual Studio Code").surfaces.view();
    expect(v.path).toEqual(["Visual Studio Code"]);
    expect(matchApps("settings", v.places)[0]!.app.id).not.toBe("/settings");
    // the place the browser lives in still counts from anywhere
    expect(matchApps("the browser", v.places)[0]!.app.name).toBe("Brave");
  });

  it("makes my app's page the place while I'm in it: 'open settings' is my settings page, not the desktop's", async () => {
    const { via, browser } = three();
    const r = await via("open settings");
    expect(r.surface).toBe("simulated web app");
    expect(browser.page.url).toContain("localhost:3000/settings");
  });

  it("applies the skills along the path, each by the surface that declared it", async () => {
    const { via, app } = three();
    expect((await via("switch to dark mode")).surface).toBe("simulated web app");
    expect(app.theme).toBe("dark");
    expect((await via("open a new tab")).r.outcome).toMatchObject({ operation: "page.tab_new" });
    expect((await via("mute")).surface).toBe("simulated desktop");
    expect((await via("search for next.js caching")).surface).toBe("simulated browser");
  });

  it("holds my app's destructive actions for a confirm", async () => {
    const { via } = three("Brave", "localhost-project");
    expect((await via("delete this project")).r.outcome).toMatchObject({ decision: "confirm", operation: "acme.delete_project" });
    expect((await via("confirm")).r.outcome).toMatchObject({ decision: "act", operation: "acme.delete_project" });
  });

  it("refuses typing into a password field, even one only named", async () => {
    const { via } = three();
    await via("open settings");
    expect((await via("type hunter2 into the password")).r.outcome).toMatchObject({ decision: "ask", hint: expect.stringContaining("password") });
    expect((await via("type rahul into the display name")).r.outcome).toMatchObject({ operation: "acme.type_into", slots: { item_label: "Display name" } });
  });
});

describe("the v2 view on the wire", () => {
  it("checks places, kinds and the path", () => {
    expect(parseView({ places: [{ name: "Pricing", id: "/pricing", kind: "page" }], path: ["Brave", "localhost:3000", "Pricing"], open: [] }).path).toHaveLength(3);
    expect(() => parseView({ apps: [], open: [] })).toThrow(ProtocolError);
    expect(() => parseView({ places: [], path: Array(11).fill("x"), open: [] })).toThrow(/path/);
    expect(() => parseView({ places: [{ name: "x", id: "x", kind: "" }], open: [] })).toThrow(/kind/);
  });
});
