import { describe, expect, it } from "vitest";
import type { PressEntry, SignalLine } from "../src/journal/journal.ts";
import type { Profile } from "../src/profile/profile.ts";
import { parseScore, worse } from "../src/review/gate.ts";
import { accept, propose, reject, substitution } from "../src/review/proposals.ts";
import { fixtureApps } from "../src/sim/fixture.ts";

const apps = fixtureApps();
const empty = (): Profile => ({ aliases: { phrases: {}, starts: {} }, phrases: [], nicknames: {}, dictationEnds: [], sites: {}, off: [], wishlist: [], decided: {} });

let clock = Date.UTC(2026, 9, 5, 9, 0, 0);
/** A press as the live loop journals it. */
function press(text: string, outcome: PressEntry["outcome"], more: Partial<PressEntry> = {}): PressEntry {
  clock += 4000;
  return { type: "press", id: `p${clock}`, t: clock, at: new Date(clock).toISOString(), source: "voice", heard: `${text}.`, speech: true, text, fixes: [], codeOnly: true, outcome, ran: outcome.decision === "act", ms: {}, ...more };
}
const ran = (text: string, operation: string, slots: Record<string, unknown> = {}) => press(text, { decision: "act", operation, slots, reason: "code" });
const asked = (text: string, reason = "unsure") => press(text, { decision: "ask", reason });

describe("finding what to propose", () => {
  it("finds the words that were swapped", () => {
    expect(substitution("open plot code", "open claude code")).toMatchObject({ heard: "plot", meant: "claude", before: "open" });
    expect(substitution("search for panther on spot if i", "search for panther on spotify")).toMatchObject({ heard: "spot if i", meant: "spotify" });
    // "opens" and "open" are the same word here: only "fortify" was misheard
    expect(substitution("opens fortify again", "open spotify again")).toMatchObject({ heard: "fortify", meant: "spotify" });
    expect(substitution("make it louder", "volume up")).toBeUndefined();
  });

  it("makes a misheard app name a nickname, which only ever matches app names", () => {
    const lines = [asked("search for panther on spot a fly"), ran("search for panther on spotify", "spotify.search", { query: "panther", app: "Spotify" })];
    expect(propose(lines, empty(), apps)[0]).toMatchObject({ kind: "nickname", app: "Spotify", name: "spot a fly" });
  });

  it("turns a miss and a rephrase into a nickname, a mishearing or a phrase", () => {
    const lines = [
      asked("open my notes"),
      ran("open obsidian", "open_app", { app: "Obsidian" }),
      asked("play the next term"),
      ran("play the next track", "media", { media: "next" }),
      asked("make it louder"),
      ran("volume up", "media", { media: "volume_up" }),
      asked("make it louder"),
      ran("volume up", "media", { media: "volume_up" }),
    ];
    const ps = propose(lines, empty(), apps);
    expect(ps.find((p) => p.kind === "nickname")).toMatchObject({ app: "Obsidian", name: "my notes", case: { said: "open my notes.", expect: { operation: "open_app", app: "Obsidian" } } });
    expect(ps.find((p) => p.kind === "mishearing")).toMatchObject({ heard: "next term", meant: "next track", where: "anywhere" });
    expect(ps.find((p) => p.kind === "phrase")).toMatchObject({ say: "make it louder", does: "volume up", case: { expect: { operation: "media", media: "volume_up" } } });
  });

  it("learns from a repair, notes what nothing can do, and turns an undone action into a case", () => {
    const wrong = ran("close the tab", "close_app", { app: "Brave" });
    const lines: Array<PressEntry | SignalLine> = [
      ran("open plot", "open_app", { app: "Notepad" }),
      ran("open claude", "open_app", { app: "Claude" }),
      wrong,
      { type: "signal", t: clock, ref: wrong.id, signal: "undone" },
      press("rotate the screen", { decision: "ask", reason: '"rotate the screen" isn\'t something I can do yet' }),
    ];
    (lines[1] as PressEntry).repair = { kind: "name", from: "open plot", to: "open claude" };
    const ps = propose(lines, empty(), apps);
    expect(ps.map((p) => p.kind).sort()).toEqual(["case", "nickname", "request"]);
    expect(ps.find((p) => p.kind === "request")).toMatchObject({ what: "rotate the screen", case: { expect: { decision: "ask" } } });
    expect(ps.find((p) => p.kind === "case")).toMatchObject({ case: { said: "close the tab.", expect: { decision: "ask" } } });
  });

  it("ignores a quick answer to a question, and anything already decided", () => {
    const twice = [asked("make it louder"), ran("volume up", "media", { media: "volume_up" })];
    const lines = [asked("open the thing"), ran("two", "open_app", { app: "Spotify" }), ...twice, ...twice.map((p) => ({ ...p, t: p.t + 60_000 }))];
    expect(propose(lines, empty(), apps).map((p) => p.key)).toEqual(["phrase:make it louder=>volume up"]);
    const prof = reject(empty(), propose(lines, empty(), apps)[0]!);
    expect(propose(lines, prof, apps)).toEqual([]);
  });
});

describe("what is never proposed", () => {
  it("a rephrase seen once, a single word in the middle, or a correction that only names the app", () => {
    expect(propose([asked("maximize it"), ran("search for pencil", "search_web", { span: "pencil" })], empty(), apps)).toEqual([]);
    const tab = ran("open a new tab in terminal", "terminal.tab_new", { app: "Terminal" }, );
    tab.repair = { kind: "again", from: "open a new tab", to: "open a new tab in terminal" };
    expect(propose([asked("open a new tab"), tab], empty(), apps)).toEqual([]);
    const meant = ran("play some music", "media", { media: "play_pause" });
    expect(propose([asked("play sum music"), meant], empty(), apps)[0]).toMatchObject({ heard: "play sum", meant: "play some" });
  });

  it("a phrase I stated myself counts the first time", () => {
    const fixed = ran("volume up", "media", { media: "volume_up" });
    fixed.repair = { kind: "again", from: "make it louder", to: "volume up" };
    expect(propose([asked("make it louder"), fixed], empty(), apps)).toMatchObject([{ kind: "phrase", say: "make it louder", does: "volume up" }]);
  });
});

describe("accepting", () => {
  it("adds each kind to the right part of the profile and remembers the decision", () => {
    const louder = [asked("make it louder"), ran("volume up", "media", { media: "volume_up" })];
    const lines = [asked("open my notes"), ran("open obsidian", "open_app", { app: "Obsidian" }), ...louder, ...louder.map((p) => ({ ...p, t: p.t + 60_000 }))];
    let prof = empty();
    for (const p of propose(lines, prof, apps)) prof = accept(prof, p);
    expect(prof.nicknames).toEqual({ Obsidian: ["my notes"] });
    expect(prof.phrases).toEqual([{ say: "make it louder", do: "volume up" }]);
    expect(Object.values(prof.decided)).toEqual(["accepted", "accepted"]);
    expect(propose(lines, prof, apps)).toEqual([]);
  });
});

describe("the gate", () => {
  it("reads both kinds of eval output and says what got worse", () => {
    const a = parseScore("desktop", "PIPELINE pass 70/70 (100.0%)");
    const b = parseScore("daily", "WRONG 0/61 (0.0%)   right 61 (100.0%) · asked 0 (0.0%)");
    expect(a).toEqual({ set: "desktop", of: 70, misses: 0, wrong: 0 });
    expect(b).toEqual({ set: "daily", of: 61, misses: 0, wrong: 0 });
    expect(worse([a, b], [{ ...a, misses: 1, wrong: 1 }, b])).toEqual(["desktop: wrong 0 → 1"]);
    expect(worse([b], [{ ...b, misses: 1 }])).toEqual(["daily: not right 0 → 1"]);
    expect(worse([a], [{ ...a, of: 72 }])).toEqual([]);
  });
});
