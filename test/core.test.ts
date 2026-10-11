import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Answer } from "../src/backends/systemone.ts";
import { normalise } from "../src/core/normalise.ts";
import { parseCount, parseDurationMs, parseKey, parseMedia, parseMoney, parseNumber, parseOrdinal, parseUrl } from "../src/core/parse.ts";
import { findAppInText, matchApps, resolveApp, targetPhrase } from "../src/core/apps.ts";
import { splitCompound } from "../src/core/compound.ts";
import { matchGrammar } from "../src/core/grammar.ts";
import { CONFIRM_MS, decide, decideWithoutModel, Session, type Outcome } from "../src/core/policy.ts";
import { resolveSlots } from "../src/core/slots.ts";
import { endsDangling, spanCandidates } from "../src/core/spans.ts";
import type { AppEntry } from "../src/core/apps.ts";
import type { SlotContext } from "../src/core/slots.ts";
import { parseCases, sameAction, slotFields } from "../src/eval/score.ts";
import { SIM_SKILLS } from "../src/sim/skills.ts";
import { SkillSet } from "../src/skills/skillset.ts";

const ctx: SlotContext = { apps: JSON.parse(readFileSync("eval/apps.json", "utf8")) as AppEntry[] };

describe("normalise", () => {
  it.each([
    ["Open Spotify.", "open spotify"],
    ["um can you please open discord for me", "open discord"],
    ["Okay so, could you launch chrome?", "launch chrome"],
    ["put explain this error into clawed code", "put explain this error into claude code"],
    ["open github dot com", "open github dot com"],
    ["Go to example.com.", "go to example.com"],
    ["Open Gethub.com", "open github.com"],
    ["Send run the tests to claw code in the terminal.", "send run the tests to claude code in the terminal"],
    ["Paste thanks uh for the update.", "paste thanks for the update"],
    ["Open uh Google Chrome and search for Google Meet.", "open google chrome and search for google meet"],
    ["A type see you tomorrow.", "type see you tomorrow"],
    ["a cat is sleeping", "a cat is sleeping"],
  ])("%s → %s", (raw, text) => {
    expect(normalise(raw).text).toBe(text);
  });

  it("records alias fixes and never empties an utterance", () => {
    expect(normalise("ask clawed code to run tests").fixes).toEqual(["clawed code → claude code"]);
    expect(normalise("um okay so").text).toBe("um okay so");
  });
});

describe("two commands in one sentence", () => {
  it.each([
    ["open spotify and search for panther", ["open spotify", "search for panther"]],
    ["open claude code and go to the first session inside the projects folder", ["open claude code", "go to the first session inside the projects folder"]],
    ["open telegram and send a message to rahul", ["open telegram", "send a message to rahul"]],
    ["go to youtube then search for lofi beats", ["go to youtube", "search for lofi beats"]],
  ])("%s is split", (text, parts) => {
    expect(splitCompound(text)).toEqual(parts);
  });

  it.each([
    "type salt and pepper",
    "search for rock and roll",
    "tell claude to open the file and run the tests",
    "paste fix the bug and add tests into claude code",
    "open chrome and spotify",
  ])("%s is one command", (text) => {
    expect(splitCompound(text)).toBeUndefined();
  });

  it("asks instead of doing the first half", () => {
    const o = decideWithoutModel(normalise("Open Spotify and search for Panther."), ctx);
    expect(o).toMatchObject({ decision: "ask", parts: ["open spotify", "search for panther"] });
  });
});

describe("parse", () => {
  it("numbers, ordinals, counts", () => {
    expect(parseNumber("twenty five")).toBe(25);
    expect(parseNumber("three hundred and two")).toBe(302);
    expect(parseNumber("1,500")).toBe(1500);
    expect(parseNumber("lots")).toBeUndefined();
    expect(parseOrdinal("click the second result")).toBe(2);
    expect(parseOrdinal("the 3rd one")).toBe(3);
    expect(parseCount("scroll down three times")).toBe(3);
    expect(parseCount("do it twice")).toBe(2);
  });

  it.each([
    ["open github dot com", "github.com"],
    ["go to example.com/docs", "example.com/docs"],
    ["open localhost 3000", "localhost:3000"],
    ["open localhost three thousand", "localhost:3000"],
    ["open gmail", "mail.google.com"],
    ["take me to reddit", "reddit.com"],
    ["open the calculator", undefined],
  ])("url: %s → %s", (text, url) => {
    expect(parseUrl(text)).toBe(url);
  });

  it("keys and media", () => {
    expect(parseKey("hit escape")).toBe("escape");
    expect(parseKey("press the enter key")).toBe("enter");
    expect(parseKey("escape")).toBeUndefined();
    expect(parseMedia("pause the music")).toBe("play_pause");
    expect(parseMedia("next song")).toBe("next");
    expect(parseMedia("turn the volume up")).toBe("volume_up");
    expect(parseMedia("mute")).toBe("mute");
    expect(parseMedia("previous track")).toBe("previous");
  });

  it("money and durations", () => {
    expect(parseMoney("send $20 to rahul")).toEqual({ amount: 20, currency: "USD" });
    expect(parseMoney("pay rahul twenty five dollars")).toEqual({ amount: 25, currency: "USD" });
    expect(parseMoney("five hundred rupees")).toEqual({ amount: 500, currency: "INR" });
    expect(parseDurationMs("wait five seconds")).toBe(5000);
    expect(parseDurationMs("in 2 minutes")).toBe(120_000);
  });
});

describe("spans", () => {
  it("only ever returns words the user said", () => {
    for (const text of ["paste hello world", "send add dark mode to claude code in the terminal", "google how to center a div"]) {
      for (const c of spanCandidates(text)) expect(text).toContain(c.text);
    }
  });

  it("Claude Code target and unfinished endings", () => {
    expect(endsDangling("open the")).toBe(true);
    expect(endsDangling("go to")).toBe(true);
    expect(endsDangling("play")).toBe(false);
    expect(endsDangling("close this")).toBe(false);
    expect(endsDangling("get vs code open")).toBe(false);
    expect(endsDangling("open")).toBe(true);
    expect(endsDangling("and then paste")).toBe(true);
  });
});

describe("slots against the eval data", () => {
  // Code-only half of the pipeline: with the right operation, every expected slot must resolve exactly.
  const cases = parseCases(readFileSync("eval/desktop.jsonl", "utf8")).filter((c) => c.expect.operation);
  const skills = new SkillSet(SIM_SKILLS);
  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const text = normalise(c.said).text;
    // a skill action's slots come from its templates; a common operation's from code
    const slots = (c.expect.operation!.includes(".") ? skills.slots(c.expect.operation!, text, ctx) : resolveSlots(c.expect.operation!, text, ctx)) ?? {};
    for (const field of slotFields(c.expect)) expect(slots[field], field).toBe(c.expect[field]);
  });
});

const pick = (choice: string, probs: Record<string, number>): Answer => {
  const ranked = Object.entries(probs).map(([option, p]) => ({ option, p })).sort((a, b) => b.p - a.p);
  return { type: "choice", choice, confidence: (ranked[0]!.p - 1 / ranked.length) / (1 - 1 / ranked.length), probabilities: probs, ranked };
};
const sure = (op: string) => pick(op, { [op]: 0.9, none: 0.05, media: 0.05 });
const answers = (op: Answer, extra: Record<string, Answer> = {}) => ({
  operation: op,
  is_command: pick("command", { command: 0.9, not_command: 0.1 }),
  complete: pick("finished", { finished: 0.9, unfinished: 0.1 }),
  ...extra,
});

describe("policy", () => {
  it("acts with resolved slots", () => {
    const o = decide(normalise("paste hello world"), answers(sure("paste_text")));
    expect(o).toMatchObject({ decision: "act", operation: "paste_text", slots: { span: "hello world" } });
  });

  it("waits on an unfinished ending whatever the model says", () => {
    expect(decide(normalise("go to"), answers(sure("open_url"))).decision).toBe("wait");
  });

  it("turns a close verb into a confirmed close even when the model reads it as safe", () => {
    const o = decide(normalise("close chrome"), answers(sure("focus_app"), { is_command: pick("not_command", { command: 0.4, not_command: 0.6 }) }), ctx);
    expect(o).toMatchObject({ decision: "confirm", operation: "close_app", slots: { app: "Google Chrome" } });
  });

  it("ignores chit-chat and asks when unsure", () => {
    expect(decide(normalise("that movie was good"), answers(sure("none"))).decision).toBe("ignore");
    const unsure = pick("open_app", { open_app: 0.3, media: 0.28, press_key: 0.22, none: 0.2 });
    expect(decide(normalise("fire up obs"), answers(unsure)).decision).toBe("ask");
  });

  it("settles open_app vs open_url by whether a site was named", () => {
    const tie = pick("open_app", { open_app: 0.45, open_url: 0.45, none: 0.1 });
    expect(decide(normalise("open gmail"), answers(tie), ctx)).toMatchObject({ decision: "act", operation: "open_url", slots: { url: "mail.google.com" } });
    const urlFirst = pick("open_url", { open_url: 0.52, open_app: 0.4, none: 0.08 });
    expect(decide(normalise("start vs code"), answers(urlFirst), ctx)).toMatchObject({ decision: "act", operation: "open_app", slots: { app: "Visual Studio Code" } });
    // a spelled-out domain stays a URL even when the model leans app
    const appFirst = pick("open_app", { open_app: 0.5, open_url: 0.45, none: 0.05 });
    expect(decide(normalise("open github dot com"), answers(appFirst), ctx)).toMatchObject({ operation: "open_url", slots: { url: "github.com" } });
  });

  it("falls back to the next operation when the pick can't be carried out", () => {
    const o = decide(normalise("type hello world"), answers(pick("open_url", { open_url: 0.5, type_text: 0.3, none: 0.2 })), ctx);
    expect(o).toMatchObject({ decision: "act", operation: "type_text", slots: { span: "hello world" } });
    expect(o.reason).toContain("no url");
  });

  it("decides '<verb> <installed app>' without the model", () => {
    expect(decideWithoutModel(normalise("fire up obs"), ctx)).toMatchObject({ decision: "act", operation: "open_app", slots: { app: "OBS Studio" } });
    expect(decideWithoutModel(normalise("show me the terminal"), ctx)).toMatchObject({ operation: "focus_app", slots: { app: "Terminal" } });
    expect(decideWithoutModel(normalise("close chrome"), ctx)).toMatchObject({ decision: "confirm", operation: "close_app", slots: { app: "Google Chrome" } });
    // not an installed app, or no app list: the model decides
    expect(decideWithoutModel(normalise("open youtube"), ctx)).toBeUndefined();
    expect(decideWithoutModel(normalise("open spotify"))).toBeUndefined();
    expect(decideWithoutModel(normalise("start the music"), ctx)).toBeUndefined();
  });

  it("lets a clear installed-app match settle an unsure open", () => {
    const unsure = pick("open_app", { open_app: 0.3, media: 0.25, paste_text: 0.25, none: 0.2 });
    expect(decide(normalise("fire up obs"), answers(unsure), ctx)).toMatchObject({ decision: "act", operation: "open_app", slots: { app: "OBS Studio" } });
    // without an app match the same answers still ask
    expect(decide(normalise("fire up the thing"), answers(unsure), ctx).decision).toBe("ask");
  });

  it("asks what to close when nothing installed matches, and closes the current window on 'this window'", () => {
    expect(decide(normalise("close the zorblax"), answers(sure("close_app")), ctx).decision).toBe("ask");
    expect(decide(normalise("close this window"), answers(sure("close_app")), ctx)).toMatchObject({ decision: "confirm", slots: { window: "current" } });
  });

  it("asks instead of acting when a needed slot is missing", () => {
    expect(decide(normalise("open the website"), answers(sure("open_url"))).decision).toBe("ask");
  });
});

describe("apps", () => {
  it.each([
    ["open spotify", "spotify"],
    ["fire up obs", "obs"],
    ["go back to vs code", "vs code"],
    ["show me the terminal", "terminal"],
    ["close this window", "this"],
    ["open notepad", "notepad"],
  ])("target of %s is %s", (text, phrase) => {
    expect(targetPhrase(text)).toBe(phrase);
  });

  it.each([
    ["spotify", "Spotify"],
    ["chrome", "Google Chrome"],
    ["vs code", "Visual Studio Code"],
    ["code", "Visual Studio Code"],
    ["terminal", "Terminal"],
    ["obs", "OBS Studio"],
    ["the calculator", "Calculator"],
    ["calculator", "Calculator"],
    ["discord", "Discord"],
  ])("%s → %s", (phrase, name) => {
    expect(resolveApp(phrase, ctx.apps)?.app.name).toBe(name);
  });

  it("matches distinctive words and prefers the shortest fit", () => {
    expect(resolveApp("powershell", ctx.apps)?.app.name).toBe("Windows PowerShell");
    expect(resolveApp("epic games", ctx.apps)?.app.name).toBe("Epic Games Launcher");
    expect(resolveApp("teams", ctx.apps)?.app.name).toBe("Microsoft Teams");
  });

  it("finds an app named anywhere in the sentence, and refuses when two are named", () => {
    expect(findAppInText("pull up chrome", ctx.apps)?.app.name).toBe("Google Chrome");
    expect(findAppInText("switch over to spotify", ctx.apps)?.app.name).toBe("Spotify");
    expect(findAppInText("open chrome and spotify", ctx.apps)).toBeUndefined();
    expect(findAppInText("windows are dirty", ctx.apps)).toBeUndefined();
  });

  it("knows no app by name itself: spoken names and noise words come from the surface", () => {
    const bare = ctx.apps.map(({ name, id }) => ({ name, id }));
    expect(matchApps("the editor", ctx.apps)[0]!.app.name).toBe("Visual Studio Code");
    expect(matchApps("the editor", bare)).toHaveLength(0);
    // "windows" is noise because the fixture desktop says so, not because the core knows Windows
    expect(matchApps("windows", ctx.apps)).toHaveLength(0);
    expect(matchApps("windows", bare)[0]?.app.name).toBe("Windows PowerShell");
  });

  it("doesn't guess between similar apps", () => {
    expect(resolveApp("windows", ctx.apps)).toBeUndefined();
    expect(resolveApp("zorblax", ctx.apps)).toBeUndefined();
  });

  it("scores open and focus as one action, nothing else", () => {
    expect(sameAction("focus_app", "open_app")).toBe(true);
    expect(sameAction("close_app", "open_app")).toBe(false);
  });
});

describe("grammar fast path", () => {
  it.each([
    ["mute", "media"],
    ["next song", "media"],
    ["turn the volume up", "media"],
    ["play", "media"],
    ["press enter", "press_key"],
    ["hit escape", "press_key"],
    ["never mind", "cancel"],
    ["no don't do that", "cancel"],
    ["nah forget it", "cancel"],
    ["yes do it", "confirm"],
    ["google how to center a div", "search_web"],
  ])("%s → %s", (text, operation) => {
    expect(matchGrammar(text)?.operation).toBe(operation);
  });

  it.each(["open spotify", "stop", "play some jazz on spotify", "paste hello world", "press the big red button"])("leaves %s to the model", (text) => {
    expect(matchGrammar(text)).toBeUndefined();
  });

  it("decides closed phrases without the model, with slots", () => {
    expect(decideWithoutModel(normalise("Mute."))).toMatchObject({ decision: "act", operation: "media", slots: { media: "mute" } });
    expect(decideWithoutModel(normalise("google how to center a div"))).toMatchObject({ operation: "search_web", slots: { span: "how to center a div" } });
    expect(decideWithoutModel(normalise("open spotify"))).toBeUndefined();
  });
});

describe("Session", () => {
  const confirmClose: Outcome = { decision: "confirm", operation: "close_app", slots: {}, reason: "test" };
  const say = (operation: string): Outcome => ({ decision: "act", operation, slots: {}, reason: "test" });

  it("runs a pending destructive action only after confirm", () => {
    const s = new Session();
    expect(s.handle(confirmClose).decision).toBe("confirm");
    expect(s.handle(say("confirm"))).toMatchObject({ decision: "act", operation: "close_app" });
    expect(s.pending).toBeUndefined();
  });

  it("drops it on cancel, and confirm with nothing waiting does nothing", () => {
    const s = new Session();
    s.handle(confirmClose);
    expect(s.handle(say("cancel")).decision).toBe("ignore");
    expect(s.handle(say("confirm")).decision).toBe("ignore");
  });

  // the confirm must be the very next thing said, within CONFIRM_MS
  it.each<[string, Outcome]>([
    ["half a sentence", { decision: "wait", reason: "ends on \"the\"" }],
    ["chatter", { decision: "ignore", reason: "model: not a command" }],
    ["a stray number", { decision: "act", operation: "choose", slots: { choice: 1 }, reason: "test" }],
  ])("drops it when %s comes first", (_, between) => {
    const s = new Session();
    s.handle(confirmClose);
    s.handle(between);
    expect(s.pending).toBeUndefined();
    expect(s.handle(say("confirm"))).toMatchObject({ decision: "ignore", reason: '"confirm" but nothing is waiting (close_app was dropped: you said something else first)' });
  });

  it("keeps it through a press with nothing said", () => {
    const s = new Session();
    s.handle(confirmClose);
    s.handle({ decision: "ignore", reason: "nothing said" });
    expect(s.handle(say("confirm"))).toMatchObject({ decision: "act", operation: "close_app", confirmed: true });
  });

  it("drops it after CONFIRM_MS", () => {
    let t = 0;
    const s = new Session(undefined, () => t);
    s.handle(confirmClose);
    t = CONFIRM_MS + 1;
    expect(s.handle(say("confirm"))).toMatchObject({ decision: "ignore", reason: `"confirm" but nothing is waiting (close_app was dropped: it waited more than ${CONFIRM_MS / 1000} s)` });
    s.handle(confirmClose);
    t += CONFIRM_MS;
    expect(s.handle(say("confirm"))).toMatchObject({ decision: "act", confirmed: true });
  });

  it("a new destructive action replaces the held one", () => {
    const s = new Session();
    s.handle(confirmClose);
    s.handle({ decision: "confirm", operation: "close_app", slots: { app: "Discord" }, reason: "test" });
    expect(s.handle(say("confirm"))).toMatchObject({ decision: "act", slots: { app: "Discord" } });
  });
});
