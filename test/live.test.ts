import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SystemOneClient } from "../src/backends/systemone.ts";
import { FLAG_PHRASE, Journal, readJournal, signalsFor, type PressEntry } from "../src/journal/journal.ts";
import { Actor, describe as describeResult } from "../src/live/actor.ts";
import { fixtureDesktop } from "../src/sim/fixture.ts";

/** Only code-decided commands are used here, so the model must never be called. */
const noModel = {
  decide: () => {
    throw new Error("model called");
  },
} as unknown as SystemOneClient;

describe("Actor", () => {
  it("runs a decided action's plan on the surface", async () => {
    const sim = fixtureDesktop();
    const actor = new Actor({ client: noModel, surface: sim });
    const r = await actor.handle("open calculator");
    expect(r.ran).toBe(true);
    expect(sim.log).toEqual([{ do: "launch", app: "Calculator" }]);
    expect(describeResult(r)).toBe("Launch Calculator");
  });

  it("holds a close until 'confirm', then runs the exact plan it showed even if the desktop changed", async () => {
    const sim = fixtureDesktop();
    const actor = new Actor({ client: noModel, surface: sim });
    const asked = await actor.handle("close chrome");
    expect(asked.pending?.summary).toBe('close "Inbox - Google Chrome"');
    expect(sim.log).toEqual([]);
    const chrome = sim.windows.find((w) => w.process === "chrome")!;
    sim.windows = [chrome]; // the desktop changes before the user confirms
    const done = await actor.handle("confirm");
    expect(done.ran).toBe(true);
    expect(sim.log).toEqual([{ do: "close", hwnd: 1001, title: "Inbox - Google Chrome" }]);
  });

  it("drops a pending close on 'cancel' and does nothing on a stray 'confirm'", async () => {
    const sim = fixtureDesktop();
    const actor = new Actor({ client: noModel, surface: sim });
    await actor.handle("close spotify");
    expect(describeResult(await actor.handle("cancel"))).toBe("Cancelled.");
    const stray = await actor.handle("confirm");
    expect(stray.ran).toBe(false);
    expect(sim.log).toEqual([]);
  });

  it("reports a plan that can't be carried out, and never runs in dry run", async () => {
    const empty = fixtureDesktop({ open: [] });
    expect((await new Actor({ client: noModel, surface: empty }).handle("close discord")).planError).toBe("Discord isn't open");
    const sim = fixtureDesktop();
    const r = await new Actor({ client: noModel, surface: sim, dryRun: true }).handle("mute");
    expect(r.ran).toBe(false);
    expect(describeResult(r)).toBe("Would media: mute (dry run).");
    expect(sim.log).toEqual([]);
  });

  it("asks for two commands one at a time when one of them isn't clear", async () => {
    const actor = new Actor({ client: noModel, surface: fixtureDesktop() });
    const r = await actor.handle("open spotify and close discord");
    expect(describeResult(r)).toBe("That's 2 commands, and I can only run them together when each one is clear. Say them one at a time: 1) open spotify  2) close discord");
  });
});

const press = (id: string, t: number, text: string, outcome: PressEntry["outcome"], extra: Partial<PressEntry> = {}): PressEntry => ({
  type: "press",
  id,
  t,
  at: new Date(t).toISOString(),
  source: "voice",
  heard: text,
  speech: true,
  text,
  fixes: [],
  codeOnly: false,
  outcome,
  ran: outcome.decision === "act",
  ms: {},
  ...extra,
});

describe("journal signals", () => {
  const acted = press("a", 0, "open discord", { decision: "act", operation: "open_app", reason: "x" });

  it("marks an action undone by a quick cancel", () => {
    const s = signalsFor([acted], press("b", 3000, "no", { decision: "ignore", reason: "x" }));
    expect(s).toEqual([{ type: "signal", t: 3000, ref: "a", signal: "undone", detail: { by: "no" } }]);
  });

  it("marks a near-repeat, an answered ask, a continued wait and a declined confirm", () => {
    expect(signalsFor([acted], press("b", 4000, "open discord app", { decision: "act", reason: "x" })).map((s) => s.signal)).toEqual(["repeated"]);
    const ask = press("a", 0, "fire up the thing", { decision: "ask", reason: "x" });
    expect(signalsFor([ask], press("b", 5000, "open obs", { decision: "act", operation: "open_app", reason: "x" }))[0]).toMatchObject({ signal: "answered_ask", detail: { operation: "open_app" } });
    const wait = press("a", 0, "open the", { decision: "wait", reason: "x" });
    expect(signalsFor([wait], press("b", 2000, "calculator", { decision: "ignore", reason: "x" }))[0]).toMatchObject({ signal: "continued_wait" });
    const confirm = press("a", 0, "close chrome", { decision: "confirm", operation: "close_app", reason: "x" });
    expect(signalsFor([confirm], press("b", 4000, "cancel", { decision: "ignore", reason: "x" })).map((s) => s.signal)).toEqual(["declined_confirm"]);
  });

  it("notes two-step sentences and empty presses, and leaves slow follow-ups alone", () => {
    expect(signalsFor([], press("a", 0, "x", { decision: "ask", reason: "x", parts: ["open a", "search b"] })).map((s) => s.signal)).toEqual(["two_step"]);
    expect(signalsFor([], press("a", 0, "", { decision: "ignore", reason: "x" }, { speech: false })).map((s) => s.signal)).toEqual(["no_speech"]);
    expect(signalsFor([acted], press("b", 60_000, "no", { decision: "ignore", reason: "x" }))).toEqual([]);
  });

  it("recognises 'that was wrong' but not sentences that merely end in wrong", () => {
    for (const s of ["that was wrong", "that's wrong", "wrong", "no that's not what i meant"]) expect(FLAG_PHRASE.test(s), s).toBe(true);
    for (const s of ["something went wrong", "what's wrong with chrome"]) expect(FLAG_PHRASE.test(s), s).toBe(false);
  });
});

describe("Journal", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("appends presses and signals per day and reads them back", () => {
    dir = mkdtempSync(join(tmpdir(), "coreloop-journal-"));
    const j = new Journal({ dir, audioDays: 30 });
    const t = Date.UTC(2026, 9, 3, 12);
    j.record(press("a", t, "open discord", { decision: "act", operation: "open_app", reason: "x" }));
    j.record(press("b", t + 2000, "cancel", { decision: "ignore", reason: "x" }));
    j.flagLast(t + 3000, "that was wrong");
    const lines = readJournal(dir);
    expect(lines.map((l) => (l.type === "press" ? `press ${l.id}` : `${l.signal} ${l.ref}`))).toEqual(["press a", "press b", "undone a", "flagged b"]);
    expect(j.audioPath("x")).toBe(join("audio", "x.wav"));
    expect(new Journal({ dir, audioDays: 0 }).audioPath("x")).toBeUndefined();
  });
});
