// The surface leads. A close verb raises whatever was chosen to a confirm, "not yet" and the verb lists come
// from the skills that are there, replies use the surface's own apps, and password fields are never voice-accessible.
import { describe, expect, it } from "vitest";
import type { Answer } from "../src/backends/systemone.ts";
import { splitCompound } from "../src/core/compound.ts";
import { itemsFor, type Item } from "../src/core/items.ts";
import { normalise } from "../src/core/normalise.ts";
import { understandByCode } from "../src/core/pipeline.ts";
import { decide, Session } from "../src/core/policy.ts";
import { parseRepair } from "../src/core/repair.ts";
import { resolveScope } from "../src/core/scope.ts";
import type { SlotContext } from "../src/core/slots.ts";
import { SimBrowser } from "../src/sim/browser.ts";
import { fixtureApps, loadPages } from "../src/sim/fixture.ts";
import { SIM_SKILLS } from "../src/sim/skills.ts";
import { SkillSet } from "../src/skills/skillset.ts";

const apps = fixtureApps();
const page = new SimBrowser(loadPages(), "example", "Brave");
const skills = new SkillSet([...SIM_SKILLS, ...page.skills]);
const ctx: SlotContext = { apps, skills };

const sure = (option: string): Answer => ({ type: "choice", choice: option, confidence: 0.9, probabilities: { [option]: 0.95, none: 0.05 }, ranked: [{ option, p: 0.95 }, { option: "none", p: 0.05 }] });
const finished: Answer = { type: "choice", choice: "finished", confidence: 0.9, probabilities: { finished: 0.95, unfinished: 0.05 }, ranked: [{ option: "finished", p: 0.95 }, { option: "unfinished", p: 0.05 }] };
const byModel = (text: string, op: string, more: Partial<SlotContext> = {}) => decide(normalise(text), { operation: sure(op), complete: finished }, { ...ctx, ...more });

describe("a close verb raises the chosen action to a confirm", () => {
  it("still closes an app it names, with a confirm", () => {
    expect(byModel("close chrome", "media")).toMatchObject({ decision: "confirm", operation: "close_app", slots: { app: "Google Chrome" } });
  });

  it("keeps the model's pick when no app is named, but never acts on it without a confirm", () => {
    expect(byModel("exit it, hit escape", "press_key")).toMatchObject({ decision: "confirm", operation: "press_key", slots: { key: "escape" } });
  });

  it("an answer to a question asked for a close verb waits for 'confirm' too", () => {
    const s = new Session(skills);
    s.handle({ decision: "ask", options: [], reason: "x", choices: [{ operation: "press_key", slots: { key: "escape" }, label: "press escape", confirm: true }] });
    expect(s.handle({ decision: "act", operation: "confirm", slots: {}, reason: "yes" })).toMatchObject({ decision: "confirm", operation: "press_key" });
    expect(s.handle({ decision: "act", operation: "confirm", slots: {}, reason: "confirm" })).toMatchObject({ decision: "act", operation: "press_key", confirmed: true });
  });

  it("never decides an operation the surface didn't declare, whatever the model says", () => {
    const pageOnly = new SkillSet(page.skills, ["search_web", "open_url"]);
    expect(byModel("close the menu", "close_app", { skills: pageOnly })).toMatchObject({ decision: "ask" });
  });
});

describe("'not yet' and the verb lists come from the skills", () => {
  it("lets a verb an action anywhere starts with through, only to that action", () => {
    expect(byModel("minimize the sidebar", "close_app")).toMatchObject({ decision: "ask", hint: expect.stringContaining("can't minimize") });
    expect(byModel("minimize the sidebar", "window.minimize")).not.toMatchObject({ hint: expect.stringContaining("can't minimize") });
  });

  it("knows a second command by a skill's own first word", () => {
    expect(splitCompound("open spotify and like it")).toBeUndefined();
    expect(splitCompound("open spotify and like it", skills.leadingWords())).toEqual(["open spotify", "like it"]);
  });

  it("knows 'I meant <a skill's sentence>' is a whole command", () => {
    expect(parseRepair("i meant minimize it", apps, true)).toEqual({ kind: "query", query: "minimize it" });
    expect(parseRepair("i meant minimize it", apps, true, skills.leadingWords())).toEqual({ kind: "again", text: "minimize it" });
  });
});

describe("the surface's own words", () => {
  it("lets the items settle a position when there are any", () => {
    const items: Item[] = [{ id: "e1", label: "Panther", role: "link", group: "result" }];
    expect(understandByCode("play the first song", { ...ctx, front: "Spotify" })?.outcome).toMatchObject({ decision: "ask", hint: expect.stringContaining("which list") });
    expect(understandByCode("play the first song", { ...ctx, front: "Spotify", items })?.outcome).not.toMatchObject({ hint: expect.stringContaining("which list") });
  });

  it("names an app the surface reports in its examples", () => {
    const o = byModel("switch", "focus_app", { open: ["Spotify"] });
    if (o.decision === "ask" && o.hint) expect(o.hint).not.toMatch(/Chrome/);
  });

  it("reads 'this page' and 'this tab' as wherever I am", () => {
    expect(resolveScope("search for panther on this page", { apps, front: "Brave" })).toMatchObject({ text: "search for panther", target: { app: "Brave", via: "here" } });
    expect(resolveScope("search for panther in this tab", { apps, front: "Brave" })).toMatchObject({ target: { app: "Brave" } });
  });
});

describe("password fields are never voice-accessible", () => {
  const login: Item[] = [
    { id: "e1", label: "Email", role: "textbox" },
    { id: "e2", label: "Password", role: "password" },
    { id: "e3", label: "Log in", role: "button" },
  ];

  it("are never among the items anything looks at", () => {
    expect(itemsFor(login, "Brave")?.map((i) => i.id)).toEqual(["e1", "e3"]);
  });

  it("are never typed into, even when named", () => {
    const o = understandByCode("type hunter2 into the password field", { ...ctx, front: "Brave", items: login })?.outcome;
    expect(o && "slots" in o ? o.slots.item : undefined).not.toBe("e2");
  });
});
