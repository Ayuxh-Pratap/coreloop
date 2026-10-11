import { afterEach, describe, expect, it, vi } from "vitest";
import { choiceConfidence, SystemOneClient, SystemOneError, validateAnswer, type Question } from "../src/backends/systemone.ts";
import { buildRequest } from "../src/core/questions.ts";

const choice: Question = { type: "choice", instructions: "pick", criteria: { a: null, b: null, c: null } };

describe("choiceConfidence", () => {
  it("is 0 for a uniform distribution and 1 for a certain one", () => {
    expect(choiceConfidence([1 / 3, 1 / 3, 1 / 3])).toBeCloseTo(0);
    expect(choiceConfidence([1, 0, 0])).toBe(1);
    expect(choiceConfidence([0.5, 0.25, 0.25])).toBeCloseTo(0.25);
  });
});

describe("validateAnswer", () => {
  it("accepts and ranks a well-formed choice", () => {
    const a = validateAnswer("q", choice, { choice: "b", probabilities: { a: 0.2, b: 0.7, c: 0.1 } });
    expect(a.type).toBe("choice");
    if (a.type !== "choice") return;
    expect(a.ranked.map((r) => r.option)).toEqual(["b", "a", "c"]);
    expect(a.confidence).toBeCloseTo((0.7 - 1 / 3) / (2 / 3));
  });

  it.each([
    ["an option that was not offered", { choice: "z", probabilities: { a: 0.2, b: 0.7, c: 0.1 } }],
    ["probabilities missing an option", { choice: "b", probabilities: { a: 0.3, b: 0.7 } }],
    ["probabilities that don't sum to 1", { choice: "b", probabilities: { a: 0.2, b: 0.9, c: 0.3 } }],
    ["a choice that is not the most likely", { choice: "a", probabilities: { a: 0.2, b: 0.7, c: 0.1 } }],
    ["no answer at all", undefined],
  ])("rejects %s", (_why, raw) => {
    expect(() => validateAnswer("q", choice, raw)).toThrow(SystemOneError);
  });

  it("checks noul and score ranges", () => {
    expect(validateAnswer("n", { type: "noul", instructions: "?" }, { noul: 0.8 })).toEqual({ type: "noul", noul: 0.8 });
    expect(() => validateAnswer("n", { type: "noul", instructions: "?" }, { noul: 1.2 })).toThrow(SystemOneError);
    const score: Question = { type: "score", instructions: "?", criteria: ["low", "mid", "high"] };
    expect(() => validateAnswer("s", score, { score: 3.5 })).toThrow(SystemOneError);
  });
});

describe("SystemOneClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates every question of a response", async () => {
    const req = buildRequest("open spotify");
    const answers = Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        if (q.type !== "choice") throw new Error("desktop request uses choices only");
        const opts = Object.keys(q.criteria);
        const probabilities = Object.fromEntries(opts.map((o, i) => [o, i === 0 ? 0.9 : 0.1 / (opts.length - 1)]));
        return [id, { type: "choice", choice: opts[0], probabilities }];
      }),
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "test", answers, usage: { input_tokens: 42 } }))));
    const d = await new SystemOneClient({ baseUrl: "http://x", timeoutMs: 1000 }).decide(req);
    expect(d.inputTokens).toBe(42);
    expect(Object.keys(d.answers)).toEqual(["operation", "complete"]);
  });

  it("reports an unreachable server with a fix", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const err = await new SystemOneClient({ baseUrl: "http://x", timeoutMs: 1000 }).decide(buildRequest("hi")).catch((e) => e);
    expect(err).toBeInstanceOf(SystemOneError);
    expect(err.code).toBe("unreachable");
    expect(err.message).toContain("models:start");
  });
});
