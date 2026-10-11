/**
 * Records the demo's data for the site: every scenario through the real engine, with the local model and
 * without it, as versioned JSON (src/demo/schema.ts). Every scenario is recorded twice and must come out the same.
 *
 *   npm run export:demo                         everything, with the model (needs `npm run models:start`)
 *   npm run export:demo -- --out <dir>          where to write it (default runs/demo/<engine version>)
 *   npm run export:demo -- --no-model           only the no-model runs
 *   npm run export:demo -- --only demo.book     scenarios whose id starts with this (repeatable)
 *   npm run export:demo -- --once               record once, without the reproduce check
 *
 * Fails when the export doesn't validate or a scenario didn't reproduce.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SystemOneClient } from "../backends/systemone.ts";
import { config } from "../config.ts";
import { exportDemo } from "../demo/export.ts";
import { evalProfileDir, useProfileFiles } from "../host/profile-files.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    "no-model": { type: "boolean", default: false },
    only: { type: "string", multiple: true },
    once: { type: "boolean", default: false },
  },
});

// the evals' fixture profile (eval/profile/): the demo is the same on every machine, and none of it is mine
const profile = useProfileFiles(evalProfileDir());
const version = (JSON.parse(readFileSync(join("packages", "engine", "package.json"), "utf8")) as { version: string }).version;
const out = values.out ?? join("runs", "demo", version);

let model: { decider: SystemOneClient; name: string } | undefined;
if (!values["no-model"]) {
  const client = new SystemOneClient({ baseUrl: config.decider.url, timeoutMs: config.decider.timeoutMs });
  const health = await client.health();
  if (!health.ok) {
    console.error(`model server not reachable at ${config.decider.url}. Start it (npm run models:start) or use --no-model`);
    process.exit(1);
  }
  model = { decider: client, name: health.model ?? "unknown" };
}

const t0 = performance.now();
const r = await exportDemo({ out, profile, once: values.once, log: (l) => console.log(l), ...(model ? { model } : {}), ...(values.only ? { only: values.only } : {}) });
const m = r.manifest;
console.log(`\nwrote ${out}: ${m.counts.scenarios} scenarios, ${m.counts.turns} turns, ${m.counts.markers} markers · engine ${m.engine}, protocol ${m.protocol}, ${m.model}${m.dirty ? " · uncommitted changes" : ""} · ${((performance.now() - t0) / 1000).toFixed(0)} s`);
const evals = JSON.parse(readFileSync(join(out, "evals.json"), "utf8")) as { sets: { set: string; runs: Record<string, Record<string, number>> }[] };
for (const s of evals.sets) {
  const runs = Object.entries(s.runs).map(([run, t]) => (t.cases !== undefined ? `${run} ${t.pass}/${t.cases}` : `${run} ${t.wrong} wrong · ${t.right} right · ${t.asked} asked`));
  console.log(`  ${s.set.padEnd(17)} ${runs.join("   |   ")}`);
}
if (r.unvisited.length) console.log(`markers no scenario passes through (${r.unvisited.length}): ${r.unvisited.join(", ")}`);
if (r.drift.length) console.error(`\ndid not reproduce (${r.drift.length}):\n  ${r.drift.join("\n  ")}`);
if (r.problems.length) console.error(`\ndoes not validate (${r.problems.length}):\n  ${r.problems.join("\n  ")}`);
if (r.drift.length || r.problems.length) process.exit(1);
console.log("valid, and every scenario reproduced");
