import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { latestRunDir, readEvents, Recorder } from "../src/recorder/recorder.ts";

describe("Recorder", () => {
  let root = "";
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  it("writes one JSON event per line and points LATEST at the run", () => {
    root = mkdtempSync(join(tmpdir(), "coreloop-runs-"));
    const rec = new Recorder(root, { source: "test" });
    rec.event("utterance", { raw: "open spotify" });
    rec.event("outcome", { decision: "act" });

    expect(latestRunDir(root)).toBe(rec.dir);
    const events = readEvents(rec.dir);
    expect(events.map((e) => e.type)).toEqual(["run_start", "utterance", "outcome"]);
    expect(events[0]).toMatchObject({ source: "test" });
    expect(events[1]).toMatchObject({ raw: "open spotify" });
    expect(events.every((e) => typeof e.t === "number")).toBe(true);
  });
});
