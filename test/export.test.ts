// The demo's export. It validates, every step's marker has its code, a scenario reproduces, and the checks
// catch what they're for. Runs without the model (the "no-model" runs); `npm run export:demo` records both.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { codeData, exportDemo, mapData, scenarios, TOUR_SETS } from "../src/demo/export.ts";
import { differences, validateExport, type TurnsFile } from "../src/demo/schema.ts";
import { loadProfile, FIXTURE_PROFILE } from "../src/host/profile-files.ts";
import { worldOf } from "../src/eval/conversation.ts";
import { fixtureApps, fixtureWindows, loadPages } from "../src/sim/fixture.ts";
import { buildWorld } from "../src/sim/world.ts";
import { Surfaces } from "../src/surface/router.ts";

const out = mkdtempSync(join(tmpdir(), "coreloop-export-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));
const read = (dir: string) => (f: string) => {
  try {
    return JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
  } catch {
    return undefined;
  }
};

describe("the demo export", () => {
  it("validates, and every scenario reproduces", { timeout: 60_000 }, async () => {
    const r = await exportDemo({ out, profile: loadProfile(FIXTURE_PROFILE), only: ["demo.", "map.", "nested."] });
    expect(r.problems).toEqual([]);
    expect(r.drift).toEqual([]);
    expect(r.manifest.counts.scenarios).toBeGreaterThan(130);
    expect(r.manifest.model).toBe("code only");
  });

  it("catches a missing turns file, a step with no marker and a wrong count", () => {
    const one = "demo.book-loop-1";
    const file = join(out, "turns", `${one}.json`);
    const good = readFileSync(file, "utf8");
    const t = JSON.parse(good) as TurnsFile;
    t.runs["no-model"]!.turns[0]!.steps[0]!.id = "no.such-marker";
    writeFileSync(file, JSON.stringify(t));
    expect(validateExport(read(out)).join("\n")).toMatch(/no\.such-marker has no marker/);
    rmSync(file);
    expect(validateExport(read(out)).join("\n")).toMatch(new RegExp(`turns/${one}\\.json: missing`));
    writeFileSync(file, good);
    expect(validateExport(read(out))).toEqual([]);
  });

  it("never holds the user's home folder or personal set", () => {
    const all = readFileSync(join(out, "scenarios.json"), "utf8") + readFileSync(join(out, "code.json"), "utf8");
    if (process.env.USERPROFILE) expect(all).not.toContain(process.env.USERPROFILE.replace(/\\/g, "\\\\"));
    expect(scenarios().some((s) => s.set === "personal")).toBe(false);
  });
});

describe("its parts", () => {
  it("lists every eval conversation, the book, the presets, the desktop cases and the map's traces", () => {
    const s = scenarios();
    expect(new Set(s.map((x) => x.id)).size).toBe(s.length);
    const tours = s.filter((x) => x.kind === "tour");
    expect(new Set(tours.map((x) => x.set))).toEqual(new Set(TOUR_SETS));
    expect(tours.length).toBe(75);
    for (const kind of ["book", "preset", "case", "map"]) expect(s.some((x) => x.kind === kind)).toBe(true);
    // the no-model chapter is only ever played without the model
    expect(s.filter((x) => x.id.startsWith("demo.book-no-model")).every((x) => x.runs.join() === "no-model")).toBe(true);
  });

  it("finds every marker at its line, and none in comments", () => {
    const code = codeData();
    expect(Object.keys(code.markers).length).toBeGreaterThan(60);
    for (const [id, m] of Object.entries(code.markers)) expect(code.files[m.file]!.split("\n")[m.line - 1]).toContain(`"${id}"`);
    expect(Object.values(code.markers).some((m) => m.file.startsWith("src/demo/"))).toBe(false);
  });

  it("reads the map's boxes, edges and labels from its template", () => {
    const template = readFileSync("docs/pipeline-map/template.html", "utf8");
    const map = mapData(template);
    const count = (re: RegExp) => [...template.matchAll(re)].length;
    expect(map.flowchart.nodes.length).toBe(count(/<g class="node /g));
    expect(map.flowchart.edges.length).toBe(count(/<path id="e-/g));
    expect(map.flowchart.labels.length).toBe(count(/<g class="elg"/g));
    expect(map.flowchart.nodes.every((n) => n.title && n.width > 0)).toBe(true);
    const boxes = new Set(map.flowchart.nodes.map((n) => n.id));
    for (const box of Object.values(map.stages)) if (box !== "*") expect(boxes.has(box)).toBe(true);
    expect(map.files.find((f) => f.file === "src/core/policy.ts")?.lines).toBeGreaterThan(100);
  });

  it("compares two recordings without their timings", () => {
    const a = { steps: [{ id: "x", note: "answered in 120 ms", t: 1.5 }], p: 0.5012, decision: "act", ms: 3 };
    expect(differences(a, { ...a, steps: [{ id: "x", note: "answered in 131 ms", t: 9 }], p: 0.5019, ms: 40 })).toEqual([]);
    expect(differences(a, { ...a, decision: "ask" })).toEqual(['decision: "act" ≠ "ask"']);
    expect(differences(a, { ...a, p: 0.6 })).toHaveLength(1);
  });

  it("builds a world from a spec", () => {
    const fx = { apps: fixtureApps(), pages: loadPages(), windows: fixtureWindows() };
    const three = buildWorld({ desktop: { open: ["Brave", "Spotify"], foreground: "Brave" }, browser: { page: "localhost-dashboard" }, webapp: true }, fx);
    expect(three.surface).toBeInstanceOf(Surfaces);
    expect(three.parts.map((p) => p.inside)).toEqual([undefined, "Brave", "localhost:3000"]);
    const alone = buildWorld(worldOf({ id: "b", surface: "browser", page: "news", turns: [] }), fx);
    expect(alone.parts).toHaveLength(1);
    expect(alone.browser?.page.url).toContain("news.example.com");
    const front = buildWorld({ desktop: "fixture", front: "Spotify" }, fx);
    expect(front.desktop?.foreground?.title).toMatch(/Spotify/);
    expect(() => buildWorld({ desktop: {}, webapp: true }, fx)).toThrow(/browser/);
    expect(() => buildWorld({ browser: { page: "no-such-page" } }, fx)).toThrow(/no page/);
  });
});
