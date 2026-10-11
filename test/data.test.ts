// Skills are plain data a surface sends (they survive JSON and are validated), slot kinds are the core's,
// and a surface's declared common operations bound what the core decides.
import { describe, expect, it } from "vitest";
import type { Answer } from "../src/backends/systemone.ts";
import { normalise } from "../src/core/normalise.ts";
import { understandByCode } from "../src/core/pipeline.ts";
import { decide } from "../src/core/policy.ts";
import { buildRequest } from "../src/core/questions.ts";
import type { SlotContext } from "../src/core/slots.ts";
import { fixtureApps } from "../src/sim/fixture.ts";
import { SIM_SKILLS } from "../src/sim/skills.ts";
import { SkillSet } from "../src/skills/skillset.ts";
import { resolveSlot } from "../src/skills/slotkinds.ts";
import { parseSkills, SkillError } from "../src/skills/validate.ts";

const apps = fixtureApps();
const skills = new SkillSet(SIM_SKILLS);

describe("skills are plain data", () => {
  it("survive JSON exactly and pass the validator", () => {
    const json = JSON.parse(JSON.stringify(SIM_SKILLS));
    expect(json).toEqual(SIM_SKILLS);
    expect(parseSkills(json)).toHaveLength(SIM_SKILLS.length);
  });

  it("decide the same after a JSON round trip", () => {
    const fromJson = new SkillSet(parseSkills(JSON.parse(JSON.stringify(SIM_SKILLS))));
    for (const [text, front] of [["search for panther", "Spotify"], ["play the first song", "Spotify"], ["new tab", "Terminal"], ["maximize spotify", undefined], ["ask cursor to add tests", undefined]] as const) {
      const ctx: SlotContext = { apps, front, lastQuery: "panther" };
      expect(understandByCode(text, { ...ctx, skills: fromJson })?.outcome).toEqual(understandByCode(text, { ...ctx, skills })?.outcome);
    }
  });

  it.each([
    [[{ id: "a", places: [], actions: [{ id: "a.x", label: "x", what: "x", risk: "maybe", templates: ["x"] }] }], "risk"],
    [[{ id: "a", places: [], actions: [{ id: "a.x", label: "x", what: "x", risk: "safe", templates: ["x {q}"], slots: { q: "colour" } }] }], "unknown kind"],
    [[{ id: "a", places: [], actions: [{ id: "a.x", label: "x", what: "x", risk: "safe", templates: [] }] }], "no templates"],
    [[{ id: "a", places: [], actions: [{ id: "open_app", label: "x", what: "x", risk: "safe", templates: ["x"] }] }], "common operation"],
    [[{ id: "a", places: [], actions: [{ id: "a.x", label: "x", what: "x", risk: "safe", templates: ["x"], run: "rm -rf /" }] }], "unknown field"],
    [[{ id: "a", places: [], actions: [{ id: "a.x", label: "x", what: "x", risk: "safe", templates: ["{q} and {q}"] }] }], "twice"],
  ])("refuses a broken skill (%#)", (data, why) => {
    expect(() => parseSkills(data)).toThrow(SkillError);
    expect(() => parseSkills(data)).toThrow(why);
  });
});

describe("slot kinds", () => {
  const ctx = { apps, lastQuery: "panther" };
  it.each([
    ["search", "penther who is a music artist", { q: "penther" }],
    ["search", "some stuff", undefined],
    ["name", "that one", { q: "panther" }],
    ["name", "the panther which appeared on the screen", { q: "panther" }],
    ["name", "@here", { q: "panther" }],
    ["app", "spot if i", { app: "Spotify" }],
    ["app", "screen", undefined],
    ["site", "github dot com", { url: "github.com" }],
    ["position", "second", { q: 2 }],
    ["position", "eleventh", undefined],
    ["words", "fix the tests", { q: "fix the tests" }],
  ] as const)("%s: %s", (kind, value, want) => {
    const got = resolveSlot(kind, "q", value, ctx);
    if (want === undefined) expect(got).toBeUndefined();
    else expect(got).toMatchObject(want);
  });

  it("'@here' with nothing searched means what's playing", () => {
    expect(resolveSlot("name", "q", "@here", { apps })).toEqual({ q: "@current" });
    // the action's own nouns: "its songs" is the last search, "some music" names nothing
    const music = ["music", "song", "songs", "artist"];
    expect(resolveSlot("name", "q", "its songs", { apps, lastQuery: "panther" }, music)).toEqual({ q: "panther" });
    expect(resolveSlot("name", "q", "the panther song", { apps }, music)).toEqual({ q: "panther" });
    expect(resolveSlot("search", "q", "some music", { apps }, music)).toBeUndefined();
    expect(resolveSlot("search", "q", "songs", { apps })).toEqual({ q: "songs" });
  });
});

describe("a surface's operations bound what the core decides", () => {
  // a browser-like surface: no apps to open or close, no Claude
  const browser = new SkillSet([], ["open_url", "search_web", "type_text", "paste_text", "press_key", "media"]);
  const sure = (option: string): Answer => ({ type: "choice", choice: option, confidence: 0.9, probabilities: { [option]: 0.95, none: 0.05 }, ranked: [{ option, p: 0.95 }, { option: "none", p: 0.05 }] });
  const finished: Answer = { type: "choice", choice: "finished", confidence: 0.9, probabilities: { finished: 0.95, unfinished: 0.05 }, ranked: [{ option: "finished", p: 0.95 }, { option: "unfinished", p: 0.05 }] };

  it("never decides an operation the surface didn't declare", () => {
    expect(understandByCode("open spotify", { apps, skills: browser })?.outcome.decision ?? "model").not.toBe("act");
    expect(decide(normalise("close chrome"), { operation: sure("close_app"), complete: finished }, { apps, skills: browser })).toMatchObject({ decision: "ask", reason: "close_app isn't something this surface does" });
    expect(understandByCode("google the weather", { apps, skills: browser })?.outcome).toMatchObject({ operation: "search_web" });
  });

  it("and the model is never offered it", () => {
    const ops = Object.keys((buildRequest("x", { operations: browser.modelOptions() }).questions.operation as { criteria: object }).criteria);
    expect(ops).toEqual(["paste_text", "type_text", "press_key", "media", "open_url", "search_web", "confirm", "cancel", "none"]);
  });

  it("an action offered everywhere is an option even when its app isn't the target", () => {
    const ids = skills.modelOptions().map((o) => o.id);
    expect(ids).toContain("claude.prompt");
    expect(ids).not.toContain("spotify.search");
    expect(skills.modelOptions(skills.forApp("Spotify")).map((o) => o.id)).toContain("spotify.search");
  });

  it("says what it can do from what it supports", () => {
    expect(skills.basics()).toBe("open, switch to or close an app, play/pause/next/volume, search the web, open a site, paste or type your words, press a key");
    expect(browser.basics()).toBe("play/pause/next/volume, search the web, open a site, paste or type your words, press a key");
  });
});
