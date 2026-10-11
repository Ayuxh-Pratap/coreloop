import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Answer } from "../src/backends/systemone.ts";
import { parseCases, percentile, scoreCase } from "../src/eval/score.ts";

const choice = (picked: string, p = 0.9): Answer => ({
  type: "choice",
  choice: picked,
  confidence: p,
  probabilities: { [picked]: p },
  ranked: [{ option: picked, p }],
});

describe("parseCases", () => {
  it("loads the desktop suite", () => {
    const cases = parseCases(readFileSync("eval/desktop.jsonl", "utf8"));
    expect(cases.length).toBeGreaterThanOrEqual(60);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("names the line of a broken case", () => {
    expect(() => parseCases('{"id":"a","said":"x","expect":{}}\n{oops', "t.jsonl")).toThrow("t.jsonl:2");
    expect(() => parseCases('{"id":"a","said":"x"}', "t.jsonl")).toThrow('needs "id", "said" and "expect"');
    expect(() => parseCases('{"id":"a","said":"x","expect":{}}\n{"id":"a","said":"y","expect":{}}')).toThrow("duplicate");
  });
});

describe("scoreCase", () => {
  const c = { id: "close-01", said: "close chrome", expect: { operation: "close_app", complete: "finished", app: "Google Chrome" }, tags: ["destructive"] };

  it("passes when every checked field matches and lists unanswerable fields as pending", () => {
    const r = scoreCase(c, { operation: choice("close_app"), complete: choice("finished") });
    expect(r.pass).toBe(true);
    expect(r.pending).toEqual(["app"]);
    expect(r.destructiveMissed).toBe(false);
  });

  it("flags a destructive request read as a safe operation", () => {
    const r = scoreCase(c, { operation: choice("focus_app"), complete: choice("finished") });
    expect(r.pass).toBe(false);
    expect(r.destructiveMissed).toBe(true);
    expect(r.fields.find((f) => f.field === "operation")).toMatchObject({ expected: "close_app", got: "focus_app", ok: false });
  });

  it("never passes a case with nothing checked", () => {
    expect(scoreCase({ id: "x", said: "x", expect: { app: "Spotify" } }, {}).pass).toBe(false);
  });
});

describe("percentile", () => {
  it("picks from a sorted list", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(30);
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
  });
});
