import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SystemOneClient } from "../src/backends/systemone.ts";
import type { AppEntry } from "../src/core/apps.ts";
import { resolveApp } from "../src/core/apps.ts";
import { normalise } from "../src/core/normalise.ts";
import { phoneticKey } from "../src/core/phonetic.ts";
import { understandByCode } from "../src/core/pipeline.ts";
import { Session, type Outcome } from "../src/core/policy.ts";
import { parseRepair } from "../src/core/repair.ts";
import { namedTarget, resolveScope } from "../src/core/scope.ts";
import { judgeTurn, parseConversations, tally } from "../src/eval/conversation.ts";
import { SimDesktop } from "../src/sim/desktop.ts";
import { SIM_SKILLS } from "../src/sim/skills.ts";
import { Actor, applyRepair, describe as describeResult } from "../src/live/actor.ts";
import { SkillSet } from "../src/skills/skillset.ts";
import { cleanQuery } from "../src/skills/query.ts";
import { resolveSlot } from "../src/skills/slotkinds.ts";
import { parseSkills } from "../src/skills/validate.ts";
import { compileTemplate, matchTemplate } from "../src/skills/template.ts";

const apps = JSON.parse(readFileSync("eval/apps.json", "utf8")) as AppEntry[];
const noModel = {
  decide: () => {
    throw new Error("model called");
  },
} as unknown as SystemOneClient;

/** A model that always reads the words as "open an app" (for sentences code can't decide alone). */
const opensApps = {
  decide: async () => ({
    model: "fake",
    inputTokens: 0,
    latencyMs: 0,
    answers: {
      operation: { type: "choice", choice: "open_app", confidence: 0.9, probabilities: { open_app: 0.95, none: 0.05 }, ranked: [{ option: "open_app", p: 0.95 }, { option: "none", p: 0.05 }] },
      complete: { type: "choice", choice: "finished", confidence: 0.9, probabilities: { finished: 0.95, unfinished: 0.05 }, ranked: [{ option: "finished", p: 0.95 }, { option: "unfinished", p: 0.05 }] },
    },
  }),
} as unknown as SystemOneClient;

/** The example skills the simulated desktop declares. */
const skills = new SkillSet(SIM_SKILLS);

/** Code-only decision of one sentence with an app in front. */
const decided = (text: string, front?: string) => understandByCode(text, { apps, skills, front })?.outcome;

describe("templates", () => {
  it("compiles words, choices, optional parts, slots and wildcards", () => {
    const t = compileTemplate("[we|let's] (change|switch) the song * to [any] [song|songs] [of|by] {query}");
    expect(matchTemplate(t, "we change the song from this current song to any song of panther")).toEqual({ query: "panther" });
    expect(matchTemplate(t, "change the song to radiohead")).toEqual({ query: "radiohead" });
    expect(matchTemplate(t, "change the channel to five")).toBeUndefined();
    expect(matchTemplate(compileTemplate("[open|create] [a] new tab"), "new tab")).toEqual({});
  });

  it("refuses a slot named twice", () => {
    expect(() => compileTemplate("{a} and {a}")).toThrow("twice");
  });

  it("every skill action has a risk, and ids are unique", () => {
    const ids = SIM_SKILLS.flatMap((s) => s.actions.map((a) => a.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(skills.risk(id)).toBeDefined();
    expect(skills.risk("browser.tab_close")).toBe("confirm");
    expect(skills.risk("terminal.tab_close")).toBe("confirm");
    // a surface can't redefine a common operation
    expect(() => new SkillSet([{ id: "x", places: [], actions: [{ id: "open_app", label: "", what: "", risk: "safe", templates: [] }] }])).toThrow("twice");
  });
});

describe("queries", () => {
  it.each([
    ["penther who is a music artist", "penther"],
    ["some arctic monkeys", "arctic monkeys"],
    ["some stuff", undefined],
    ["the next song", undefined],
    ["cats in paris", "cats in paris"],
  ])("%s → %s", (span, q) => {
    expect(cleanQuery(span)).toBe(q);
  });

  it("knows the action's own nouns name nothing on their own", () => {
    expect(cleanQuery("some music")).toBe("music");
    expect(cleanQuery("some music", ["music", "song"])).toBeUndefined();
  });
});

describe("names by sound", () => {
  it("matches misheard names only against installed apps", () => {
    expect(phoneticKey("cloud")).toBe(phoneticKey("claude"));
    expect(resolveApp("cloud", apps)?.app.name).toBe("Claude");
    expect(resolveApp("spot if i", apps)?.app.name).toBe("Spotify");
    expect(resolveApp("terminals", apps)?.app.name).toBe("Terminal");
    expect(resolveApp("panther", apps)).toBeUndefined();
  });

  it("applies my mishearings from profile/aliases.json", () => {
    expect(normalise("Nose Spotify.").text).toBe("close spotify");
    expect(normalise("Put the plot code on top.").text).toBe("put the claude code on top");
    expect(normalise("Go to the next term.").text).toBe("go to the next track");
    // "nose" only as the first word
    expect(normalise("my nose is cold").text).toBe("my nose is cold");
  });
});

describe("target app", () => {
  it.each([
    ["search for panther on spotify", "Spotify", "search for panther"],
    ["on the spotify app search for panther", "Spotify", "search for panther"],
    ["search for panther on the brave browser", "Brave", "search for panther"],
    ["open a new tab on terminals", "Terminal", "open a new tab"],
  ])("%s → %s: %s", (text, app, rest) => {
    expect(namedTarget(text, apps)).toMatchObject({ app, rest });
  });

  it("keeps words that don't name an installed app as a whole; dictation loses only a trailing 'in <app>'", () => {
    expect(namedTarget("search for cafes in paris", apps)).toBeUndefined();
    expect(namedTarget("play the song which appeared on the screen", apps)).toBeUndefined(); // not On-Screen Keyboard
    expect(namedTarget("type see you in chrome", apps)).toMatchObject({ app: "Google Chrome", rest: "type see you" });
    expect(namedTarget("type meet me in brave new world", apps)).toBeUndefined();
    // a sentence one of the surface's own templates reads whole stays whole ("paste X into claude code")
    expect(resolveScope("paste hello into claude code", { apps, skills }).target).toBeUndefined();
    expect(namedTarget("paste hello into claude code", apps)).toMatchObject({ app: "Claude" }); // without the skill, it would be cut
  });

  it("falls back to the app in front, then the one just opened", () => {
    expect(resolveScope("search for x", { apps, front: "Brave" }).target).toEqual({ app: "Brave", via: "front" });
    expect(resolveScope("search for x", { apps, recent: "Spotify" }).target).toEqual({ app: "Spotify", via: "recent" });
    expect(resolveScope("search for x on spotify", { apps, front: "Brave" }).target).toEqual({ app: "Spotify", via: "named" });
  });
});

describe("skills decide in context", () => {
  it("the same words mean different actions in different apps", () => {
    expect(decided("search for panther", "Spotify")).toMatchObject({ operation: "spotify.search", slots: { query: "panther" } });
    expect(decided("search for panther", "Brave")).toMatchObject({ operation: "browser.search", slots: { query: "panther", app: "Brave" } });
    expect(decided("search for panther")).toMatchObject({ operation: "search_web", slots: { span: "panther" } });
    expect(decided("new tab", "Terminal")).toMatchObject({ operation: "terminal.tab_new" });
    expect(decided("new tab", "Google Chrome")).toMatchObject({ operation: "browser.tab_new", slots: { app: "Google Chrome" } });
  });

  it("app verbs still win over a skill's templates", () => {
    expect(decided("open brave", "Spotify")).toMatchObject({ operation: "open_app", slots: { app: "Brave" } });
    expect(decided("go back to cursor", "Google Chrome")).toMatchObject({ operation: "focus_app", slots: { app: "Cursor" } });
  });

  it("'play some music' is press play, 'play radiohead' plays an artist", () => {
    expect(decided("play radiohead", "Spotify")).toMatchObject({ operation: "spotify.play", slots: { query: "radiohead" } });
    expect(decided("play the song blinding lights", "Spotify")).toMatchObject({ slots: { query: "blinding lights", kind: "track" } });
    expect(decided("play some music", "Spotify")?.decision ?? "model").not.toBe("act");
  });

  it("closing a tab needs a confirm", () => {
    expect(decided("close this tab", "Brave")).toMatchObject({ decision: "confirm", operation: "browser.tab_close" });
  });

  it("templates that name their app work from anywhere", () => {
    expect(decided("ask cursor to add tests")).toMatchObject({ operation: "cursor.chat", slots: { span: "add tests", app: "Cursor" } });
  });

  it("a named app without that action never acts somewhere else", () => {
    const o = decided("google cheap flights on spotify") as Extract<Outcome, { decision: "ask" }>;
    expect(o.decision).toBe("ask");
    expect(o.hint).toContain("In Spotify I can:");
    expect((decided("google cheap flights on notepad") as Extract<Outcome, { decision: "ask" }>).hint).toContain("Notepad has no actions of its own yet: I can open it, switch to it or close it");
  });

  it("a surface plans the decided action: the app comes to the front first, and the plan says what it shows", () => {
    const sim = new SimDesktop(apps, { open: ["Brave", "Terminal"], foreground: "Terminal" });
    const search = sim.plan(decided("search for panther on brave") as never);
    expect(search).toMatchObject({ summary: 'search Brave for "panther"', shows: "Brave" });
    expect(search.detail).toEqual(['focus "Brave"', "wait 300 ms", "browser.search in Brave"]);
    expect(sim.plan(decided("new tab", "Terminal") as never)).toMatchObject({ summary: "open a new Terminal tab", shows: "Terminal" });
  });

  it("finding a chat is a fill, never a send", () => {
    const sim = new SimDesktop(apps, { open: ["Telegram"], foreground: "Telegram" });
    const o = decided("find rahul", "Telegram")!;
    expect(o).toMatchObject({ decision: "act", operation: "telegram.find_chat", slots: { query: "rahul" } });
    expect(skills.risk("telegram.find_chat")).toBe("fill");
    expect(sim.plan(o as never).detail.some((d) => d.includes("enter"))).toBe(false);
  });
});

describe("answerable questions", () => {
  const ask: Outcome = {
    decision: "ask",
    options: [],
    reason: "test",
    choices: [
      { operation: "media", slots: { media: "next" }, label: "next track" },
      { operation: "open_app", slots: { app: "Spotify" }, label: "open Spotify" },
    ],
  };
  const say = (operation: string, slots = {}): Outcome => ({ decision: "act", operation, slots, reason: "test" });

  it("'two' runs the second choice; a bare 'yes' to two choices asks which", () => {
    const s = new Session();
    s.handle(ask);
    expect(s.handle(say("choose", { choice: 2 }))).toMatchObject({ decision: "act", operation: "open_app" });
    s.handle(ask);
    const again = s.handle(say("confirm"));
    expect(again).toMatchObject({ decision: "ask", hint: 'Say "one" or "two".' });
    expect(s.handle(say("choose", { choice: 1 }))).toMatchObject({ operation: "media" });
  });

  it("an answer with nothing asked does nothing", () => {
    expect(new Session().handle(say("choose", { choice: 1 })).decision).toBe("ignore");
  });
});

describe("repairs", () => {
  it.each([
    ["no i meant claude code", { kind: "name", name: "claude code" }],
    ["no search on brave", { kind: "target", target: "brave" }],
    ["in this window", { kind: "target", target: "here" }],
    ["i mean change the song", { kind: "again", text: "change the song" }],
    ["not panther pantera", { kind: "swap" }],
    ["undo that", { kind: "undo" }],
    ["scratch that", { kind: "undo" }],
  ])("%s", (text, repair) => {
    expect(parseRepair(text, apps, true)).toMatchObject(repair);
  });

  it("leaves ordinary commands alone", () => {
    for (const text of ["open spotify", "search for panther", "no", "yes", "close chrome"]) expect(parseRepair(text, apps, false)).toBeUndefined();
  });

  it("edits the previous command", () => {
    const last = { text: "open crawled code", scopeText: "open crawled code", outcome: { decision: "ask", options: [], reason: "" } as Outcome };
    expect(applyRepair({ kind: "name", name: "claude code" }, last)).toBe("open claude code");
    const search = { text: "search for panther", scopeText: "search for panther", outcome: { decision: "act", operation: "spotify.search", slots: { query: "panther" }, reason: "" } as Outcome };
    expect(applyRepair({ kind: "target", target: "brave" }, search)).toBe("search for panther on brave");
    expect(applyRepair({ kind: "query", query: "pantera" }, search)).toBe("search for pantera");
  });
});

describe("conversations on a simulated desktop", () => {
  const actor = (spec = { open: ["Terminal", "Google Chrome"], foreground: "Terminal" }) => {
    const sim = new SimDesktop(apps, spec);
    return { sim, actor: new Actor({ client: opensApps, surface: sim }) };
  };

  it("an app just opened is where the next command goes", async () => {
    const { sim, actor: a } = actor();
    await a.handle("open brave");
    expect(sim.foreground?.process).toBe("brave");
    const r = await a.handle("search for panther");
    expect(r.outcome).toMatchObject({ operation: "browser.search", slots: { app: "Brave" } });
  });

  it("'no, search on chrome' re-runs the search in Chrome", async () => {
    const { sim, actor: a } = actor({ open: ["Terminal", "Google Chrome", "Spotify"], foreground: "Spotify" });
    await a.handle("search for panther");
    const r = await a.handle("no, search on chrome");
    expect(r.repair).toMatchObject({ kind: "target", to: "search for panther on chrome" });
    expect(sim.log.at(-1)).toEqual({ do: "act", id: "browser.search", app: "Google Chrome" });
    expect(r.plan?.summary).toBe('search Google Chrome for "panther"');
  });

  it("'no, I meant Spotify' fixes a misheard name", async () => {
    const { actor: a } = actor();
    const first = await a.handle("open zorblax");
    expect(describeResult(first)).toContain('No app here is called "zorblax"');
    const r = await a.handle("no, I meant Spotify");
    expect(r.outcome).toMatchObject({ operation: "open_app", slots: { app: "Spotify" } });
  });

  it("runs two clear commands in a row, the second in the app the first opened", async () => {
    const { sim, actor: a } = actor({ open: ["Terminal"], foreground: "Terminal" });
    const r = await a.handle("open spotify and search for panther");
    expect(r.ran).toBe(true);
    expect(sim.log.map((s) => s.do)).toEqual(["launch", "act"]);
    expect(describeResult(r)).toBe('Launch Spotify, then search Spotify for "panther"');
  });

  it("never runs a destructive step as part of a pair", async () => {
    const { sim, actor: a } = actor({ open: ["Terminal", "Spotify"], foreground: "Terminal" });
    const r = await a.handle("close spotify and open brave");
    expect(r.outcome.decision).toBe("ask");
    expect(sim.log).toEqual([]);
  });

  it("undoes a focus and a media key; says so when it can't", async () => {
    const { sim, actor: a } = actor();
    await a.handle("switch to chrome");
    const back = await a.handle("undo that");
    expect(back.ran).toBe(true);
    expect(sim.log.at(-1)).toMatchObject({ do: "focus", title: "Terminal" });
    await a.handle("search for panther");
    expect(describeResult(await a.handle("undo that"))).toContain("can't undo");
  });

  it("scores each turn right, asked or wrong", async () => {
    const [c] = parseConversations(JSON.stringify([{ id: "t", desktop: { open: ["Terminal"] }, turns: [{ said: "x", expect: { operation: "open_app", app: "Spotify" } }] }]));
    const { actor: a } = actor();
    const right = judgeTurn(c!.turns[0]!, await a.handle("open spotify"));
    const asked = judgeTurn(c!.turns[0]!, await a.handle("open zorblax"));
    const wrong = judgeTurn(c!.turns[0]!, await a.handle("open chrome"));
    expect([right.verdict, asked.verdict, wrong.verdict]).toEqual(["right", "asked", "wrong"]);
    expect(tally([{ ...right, verdict: "right" } as never, { verdict: "wrong" } as never])).toMatchObject({ right: 1, wrong: 1, n: 2 });
  });

  it("loads the daily sets", () => {
    for (const f of ["eval/daily.json", "eval/daily-holdout.json"]) expect(parseConversations(readFileSync(f, "utf8"), f).length).toBeGreaterThan(0);
    expect(skills.forApp("Brave")?.id).toBe("browser");
    expect(skills.matchSkill(skills.forApp("Spotify")!, "like this song", { apps })?.action.id).toBe("spotify.like");
  });
});

describe("small fixes from writing the docs (2026-10-08)", () => {
  it("'last' is a position, as -1; eleven is not", () => {
    expect(resolveSlot("position", "choice", "last", { apps: [] })).toEqual({ choice: -1 });
    expect(resolveSlot("position", "choice", "second", { apps: [] })).toEqual({ choice: 2 });
    expect(resolveSlot("position", "choice", "eleven", { apps: [] })).toBeUndefined();
  });

  const result = (outcome: Outcome) => ({ understood: { norm: { raw: "x", text: "x" } }, outcome, ran: false }) as unknown as Parameters<typeof describeResult>[0];

  it("a question with three choices offers all three numbers", () => {
    const choices = ["a", "b", "c"].map((label) => ({ operation: "media", slots: {}, label }));
    expect(describeResult(result({ decision: "ask", options: [], choices, reason: "test" }))).toContain('Say "one" or "two" or "three".');
    expect(describeResult(result({ decision: "ask", options: [], choices: choices.slice(0, 2), reason: "test" }))).toContain('Say "one" or "two".');
  });

  it("an action that's never done by voice says so", () => {
    expect(describeResult(result({ decision: "ignore", reason: "bank.wire is not voice-accessible" }))).toBe(`Heard "x": that can't be done by voice.`);
  });
});

describe("skill limits", () => {
  const action = { id: "x.go", label: "go", what: "go somewhere (go home)", risk: "safe", templates: ["go home"] };
  const fails = (skills: unknown) => {
    try {
      parseSkills(skills);
    } catch (e) {
      return (e as Error).message;
    }
    return "passed";
  };
  it("refuses unknown skill fields, long text and too many templates", () => {
    expect(fails([{ id: "x", places: [], actions: [action], extra: 1 }])).toBe('skills[0] (x): unknown field "extra"');
    expect(fails([{ id: "x", places: [], actions: [{ ...action, what: "w".repeat(301) }] }])).toBe('skills[0] (x).actions[0] (x.go): "what" is longer than 300 characters');
    expect(fails([{ id: "x", places: [], actions: [{ ...action, templates: Array.from({ length: 201 }, (_, i) => `go ${i}`) }] }])).toBe("skills[0] (x).actions[0] (x.go): more than 200 templates");
    expect(fails([{ id: "x", places: [], actions: [action] }])).toBe("passed");
  });
  it("checks an in-process surface's skills when the actor starts", () => {
    const surface = new SimDesktop([], {}, [{ id: "x", places: [], actions: [{ ...action, risk: "risky" }] }] as never);
    expect(() => new Actor({ client: {} as never, surface })).toThrow('"risk" must be one of');
  });
});
