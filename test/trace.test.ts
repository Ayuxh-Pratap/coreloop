// The engine's trace. Off unless asked for, it never changes a decision, and every step's marker is a string in
// the source, so the simulation site can show the exact line.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodeOnlyDecider } from "../src/backends/codeonly.ts";
import { step, traced, tracing } from "../src/core/trace.ts";
import { Actor } from "../src/live/actor.ts";
import { SimBrowser } from "../src/sim/browser.ts";
import { fixtureDesktop, loadPages } from "../src/sim/fixture.ts";
import { SimWebApp } from "../src/sim/webapp.ts";
import { Surfaces } from "../src/surface/router.ts";

const SAID = ["Um, open settings please.", "open a new tab", "type hunter2 into the password", "close spotify", "confirm", "put something relaxing on"];

function three() {
  const desktop = fixtureDesktop({ open: ["Brave", "Visual Studio Code", "Spotify"], foreground: "Brave" });
  const browser = new SimBrowser(loadPages(), "localhost-dashboard", "Brave");
  return new Actor({ client: new CodeOnlyDecider(), surface: new Surfaces([desktop, browser, new SimWebApp(browser)]) });
}

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [readFileSync(p, "utf8")] : [];
  });

describe("the trace", () => {
  it("records nothing unless asked", () => {
    expect(tracing()).toBe(false);
    step("x", "x", "nothing records this");
    expect(tracing()).toBe(false);
  });

  it("never changes a decision", async () => {
    const plain = three();
    const watched = three();
    for (const said of SAID) {
      const a = (await plain.handle(said)).outcome;
      const { value } = await traced(() => watched.handle(said));
      expect(value.outcome).toEqual(a);
    }
  });

  it("walks a command through the stages in order, and every marker is in the source", async () => {
    const actor = three();
    const { steps } = await traced(() => actor.handle("Um, open settings please."));
    expect(steps.map((s) => s.id)).toEqual(expect.arrayContaining(["normalise.filler", "scope.target", "slots.place", "policy.app-verb", "policy.finish", "router.route", "actor.plan", "actor.run"]));
    const all = new Set<string>();
    for (const said of SAID) for (const s of (await traced(() => actor.handle(said))).steps) all.add(s.id);
    const code = sources("src").join("\n");
    for (const id of all) expect(code.includes(`"${id}"`), id).toBe(true);
  });
});
