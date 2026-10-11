// Day-2 fixes, as core behaviour: the app in use (never coreloop's own host), "I can't … yet" instead of the
// nearest wrong action, names from memory ("its music", "the first song"), typing into a named app, and sending
// only on a spoken confirm. Run on the simulated desktop surface with its example skills.
import { describe, expect, it } from "vitest";
import type { Answer, SystemOneClient } from "../src/backends/systemone.ts";
import { nameApp } from "../src/core/apps.ts";
import { normalise } from "../src/core/normalise.ts";
import { understandByCode } from "../src/core/pipeline.ts";
import { decide } from "../src/core/policy.ts";
import { parseRepair } from "../src/core/repair.ts";
import type { SlotContext } from "../src/core/slots.ts";
import { Actor } from "../src/live/actor.ts";
import { SimDesktop } from "../src/sim/desktop.ts";
import { fixtureApps } from "../src/sim/fixture.ts";
import { SIM_SKILLS } from "../src/sim/skills.ts";
import { SkillSet } from "../src/skills/skillset.ts";

const apps = fixtureApps();
const skills = new SkillSet(SIM_SKILLS);
const decided = (text: string, ctx: Partial<SlotContext> = {}) => understandByCode(text, { apps, skills, ...ctx })?.outcome;
/** The operation code decided, if any. */
const opOf = (text: string, ctx: Partial<SlotContext> = {}) => {
  const o = decided(text, ctx);
  return o && "operation" in o ? o.operation : undefined;
};

const sure = (option: string): Answer => ({ type: "choice", choice: option, confidence: 0.9, probabilities: { [option]: 0.95, none: 0.05 }, ranked: [{ option, p: 0.95 }, { option: "none", p: 0.05 }] });
const finished: Answer = { type: "choice", choice: "finished", confidence: 0.9, probabilities: { finished: 0.95, unfinished: 0.05 }, ranked: [{ option: "finished", p: 0.95 }, { option: "unfinished", p: 0.05 }] };

/** A model that always picks the same operation (for sentences code can't decide alone). */
const picks = (option: string) =>
  ({ decide: async () => ({ model: "fake", inputTokens: 0, latencyMs: 0, answers: { operation: sure(option), complete: finished } }) }) as unknown as SystemOneClient;

describe("the app in use, not coreloop's own host", () => {
  it("skips the host window and minimized windows", async () => {
    const sim = new SimDesktop(apps, { open: ["Cursor", "Spotify", "Brave"], foreground: "Cursor", host: "Cursor" });
    const actor = new Actor({ client: picks("none"), surface: sim });
    expect((await actor.handle("search for panther")).outcome).toMatchObject({ operation: "spotify.search" });
    sim.afterTurn();
    await actor.handle("minimize spotify");
    sim.afterTurn();
    expect((await actor.handle("new tab")).outcome).toMatchObject({ operation: "browser.tab_new", slots: { app: "Brave" } });
  });

  it("without a host, the window in front is the app in use", async () => {
    const sim = new SimDesktop(apps, { open: ["Cursor", "Spotify"], foreground: "Cursor" });
    const actor = new Actor({ client: picks("search_web"), surface: sim });
    expect((await actor.handle("search for panther")).outcome).toMatchObject({ operation: "search_web" });
  });
});

describe("windows (example skills)", () => {
  it.each([
    ["maximize spotify", "window.maximize", "Spotify"],
    ["make spotify full screen", "window.maximize", "Spotify"],
    ["expand spotify", "window.maximize", "Spotify"],
    ["minimize the spotify", "window.minimize", "Spotify"],
    ["restore chrome", "window.restore", "Google Chrome"],
    ["snap brave to the right", "window.snap", "Brave"],
  ])("%s → %s %s", (text, operation, app) => {
    expect(decided(text)).toMatchObject({ decision: "act", operation, slots: { app } });
  });

  it("'maximize it' acts on the window in use", () => {
    const sim = new SimDesktop(apps, { open: ["Cursor", "Spotify"], foreground: "Cursor", host: "Cursor" });
    expect(sim.plan(decided("maximize it") as never)).toMatchObject({ summary: 'maximize "Spotify"' });
  });

  it("a verb with no action never becomes the nearest wrong one", () => {
    const ctx: SlotContext = { apps, skills };
    // day 2: "minimize the spotify" became a close; "maximize it" became typing
    expect(decide(normalise("minimize the sidebar"), { operation: sure("close_app"), complete: finished }, ctx)).toMatchObject({ decision: "ask", hint: expect.stringContaining("can't minimize") });
    expect(decide(normalise("send the prompt"), { operation: sure("paste_text"), complete: finished }, ctx).decision).toBe("ask");
    expect(decide(normalise("delete this tab"), { operation: sure("cancel"), complete: finished }, ctx).decision).toBe("ask");
  });

  it("with no surface skills, the core still has the common operations only", () => {
    expect(opOf("maximize spotify", { skills: undefined })).toBeUndefined();
    expect(opOf("open spotify", { skills: undefined })).toBe("open_app");
  });
});

describe("names from memory", () => {
  const spotify = { front: "Spotify", lastQuery: "panther" };

  it("'the first song' and 'the artist profile' mean the last search", () => {
    expect(decided("play the first song on the screen", spotify)).toMatchObject({ operation: "spotify.play_result", slots: { query: "panther", choice: 1 } });
    expect(decided("open the artist profile", spotify)).toMatchObject({ operation: "spotify.open_artist", slots: { query: "panther" } });
    expect(decided("start playing its music", spotify)).toMatchObject({ operation: "spotify.play", slots: { query: "panther" } });
    expect(decided("play his music", spotify)).toMatchObject({ slots: { query: "panther" } });
    // with nothing searched, "the first song" says there's no list (on day 2 it pressed play/pause)
    expect(decided("play the first song", { front: "Spotify" })).toMatchObject({ decision: "ask", hint: expect.stringContaining("which list you mean") });
    expect(decided("play the first song", { front: "Brave", open: ["Brave", "Spotify"] })?.decision).toBe("ask");
  });

  it("cleans names and keeps 'some music' as press play", () => {
    expect(decided("play the panther song which appeared on the screen", spotify)).toMatchObject({ slots: { query: "panther" } });
    expect(decided("open divine's profile", spotify)).toMatchObject({ operation: "spotify.open_artist", slots: { query: "divine" } });
    expect(opOf("play some music", { front: "Spotify" })).not.toBe("spotify.play");
  });

  it("words only an open app can mean work while it's behind another app", () => {
    expect(decided("play any panther song", { front: "Brave", open: ["Brave", "Spotify"] })).toMatchObject({ operation: "spotify.play", slots: { query: "panther", app: "Spotify" } });
    expect(decided("search for panther", { front: "Brave", open: ["Brave", "Spotify"] })).toMatchObject({ operation: "browser.search" });
  });
});

describe("typing into an app, and sending only after confirm", () => {
  it("types into the app named at the end, and holds Enter for a confirm", () => {
    const o = decided("type npm test and run it in the terminal")!;
    expect(o).toMatchObject({ decision: "confirm", operation: "type_text", slots: { span: "npm test", submit: true, app: "Terminal" } });
    const sim = new SimDesktop(apps, { open: ["Terminal", "Claude"], foreground: "Claude" });
    expect(sim.plan(o as never).detail).toEqual(['focus "Terminal"', "wait 300 ms", 'type "npm test" (no Enter)', "wait 150 ms", "keys enter"]);
  });

  it("'type X in claude code' puts the words into Claude Code, not sent", () => {
    expect(decided(normalise("Type How Are You in plot code.").text)).toMatchObject({ operation: "claude.prompt", slots: { span: "how are you", claude_target: "app" } });
  });
});

describe("names", () => {
  it("joins spelled-out letters", () => {
    expect(normalise("Search P A N T H E R on Spotify.").text).toBe("search panther on spotify");
  });

  it("an app is named as a whole, never by one shared word", () => {
    expect(nameApp("screen", apps)).toBeUndefined();
    expect(nameApp("center", apps)).toBeUndefined();
    expect(nameApp("brave browser", apps)?.app.name).toBe("Brave");
  });

  it("after a search, 'I meant X' replaces the search term", () => {
    expect(parseRepair("no i meant center", apps, true)).toEqual({ kind: "query", query: "center" });
    expect(parseRepair("no i meant spotify", apps, true)).toEqual({ kind: "name", name: "spotify" });
  });
});
