// No-model mode. Code decides what it can; the rest is a question, never an error or a guess. The fallback uses
// the model while it answers and code only while it's unreachable.
import { describe, expect, it } from "vitest";
import { CodeOnlyDecider, FallbackDecider } from "../src/backends/codeonly.ts";
import { SystemOneError, type Decider, type Decision } from "../src/backends/systemone.ts";
import { understand } from "../src/core/pipeline.ts";
import { Actor } from "../src/live/actor.ts";
import { fixtureApps, fixtureDesktop } from "../src/sim/fixture.ts";
import { SIM_SKILLS } from "../src/sim/skills.ts";
import { SkillSet } from "../src/skills/skillset.ts";

const ctx = { apps: fixtureApps(), skills: new SkillSet(SIM_SKILLS) };
const answered: Decision = {
  model: "fake",
  inputTokens: 0,
  latencyMs: 0,
  answers: {
    operation: { type: "choice", choice: "media", confidence: 0.9, probabilities: { media: 0.95, none: 0.05 }, ranked: [{ option: "media", p: 0.95 }, { option: "none", p: 0.05 }] },
    complete: { type: "choice", choice: "finished", confidence: 0.9, probabilities: { finished: 0.95 }, ranked: [{ option: "finished", p: 0.95 }] },
  },
};

describe("no-model mode", () => {
  it("does what code decides, exactly as with the model", async () => {
    const u = await understand(new CodeOnlyDecider(), "open spotify", { ctx });
    expect(u.outcome).toMatchObject({ decision: "act", operation: "open_app", slots: { app: "Spotify" } });
  });

  it("asks about the rest, saying what it can do, instead of failing or guessing", async () => {
    const u = await understand(new CodeOnlyDecider(), "put something relaxing in the background", { ctx });
    expect(u.outcome).toMatchObject({ decision: "ask", hint: expect.stringContaining("the model isn't running") });
  });

  it("still holds a close for a spoken confirm, and never acts on it alone", async () => {
    const actor = new Actor({ client: new CodeOnlyDecider(), surface: fixtureDesktop({ open: ["Spotify", "Brave"], foreground: "Brave" }) });
    expect((await actor.handle("close spotify")).outcome).toMatchObject({ decision: "confirm", operation: "close_app" });
    expect((await actor.handle("confirm")).outcome).toMatchObject({ decision: "act", operation: "close_app", confirmed: true });
  });
});

describe("the fallback", () => {
  const flaky = (fail: () => Error | undefined): Decider => ({
    decide: async () => {
      const err = fail();
      if (err) throw err;
      return answered;
    },
  });

  it("uses code only while the model is unreachable, and the model again once it answers", async () => {
    let down = true;
    const changes: boolean[] = [];
    const d = new FallbackDecider(flaky(() => (down ? new SystemOneError("unreachable", "connection refused") : undefined)), { onChange: (m) => changes.push(m) });
    const u = await understand(d, "put something relaxing in the background", { ctx });
    expect(u.outcome.decision).toBe("ask");
    expect(d.model).toBe(false);
    down = false;
    expect((await understand(d, "put something relaxing in the background", { ctx })).decision?.model).toBe("fake");
    expect(changes).toEqual([false, true]);
  });

  it("doesn't hide a model that answers badly", async () => {
    const d = new FallbackDecider(flaky(() => new SystemOneError("invalid_answer", "probabilities don't add up")));
    await expect(understand(d, "put something relaxing in the background", { ctx })).rejects.toThrow(/add up/);
  });
});
