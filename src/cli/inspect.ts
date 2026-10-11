/**
 * Inspector: shows what the model thinks of an utterance WITHOUT acting on it.
 *
 *   npm run inspect -- "open spotify"
 *   npm run inspect -- "open spotify" --runs 10        latency stats over 10 calls
 *   npm run inspect -- "open spotify" --packed         independent:false (one copy of the state)
 *   npm run inspect -- "open spotify" --json           raw decision as JSON
 */
import { parseArgs } from "node:util";
import { SystemOneClient, SystemOneError, type Decision } from "../backends/systemone.ts";
import { config } from "../config.ts";
import { useProfileFiles } from "../host/profile-files.ts";
import { buildRequest } from "../core/questions.ts";

// the person's profile (mishearings, phrases, nicknames, actions turned off), handed to the engine
useProfileFiles();

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: "string", default: "1" },
    packed: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    top: { type: "string", default: "3" },
  },
});
const text = positionals.join(" ").trim();
if (!text) {
  console.error('usage: npm run inspect -- "open spotify" [--runs N] [--packed] [--json]');
  process.exit(2);
}

const client = new SystemOneClient({ baseUrl: config.decider.url, timeoutMs: config.decider.timeoutMs });
const health = await client.health();
if (!health.ok) {
  console.error(`model server not reachable at ${config.decider.url}. Start it: npm run models:start`);
  process.exit(1);
}

const req = buildRequest(text, { independent: values.packed ? false : undefined });
const runs = Math.max(1, Number(values.runs));
const latencies: number[] = [];
let last: Decision | undefined;
try {
  for (let i = 0; i < runs; i++) {
    last = await client.decide(req);
    latencies.push(last.latencyMs);
  }
} catch (err) {
  console.error(err instanceof SystemOneError ? `${err.code}: ${err.message}` : err);
  process.exit(1);
}
const d = last!;

if (values.json) {
  console.log(JSON.stringify({ ...d, latencies }, null, 2));
  process.exit(0);
}

const pct = (p: number) => `${(p * 100).toFixed(1).padStart(5)}%`;
const top = Math.max(1, Number(values.top));
console.log(`\n"${text}"  ·  ${d.model}  ·  ${d.inputTokens} input tokens${values.packed ? "  ·  packed" : ""}\n`);
for (const [id, a] of Object.entries(d.answers)) {
  if (a.type === "choice") {
    const alts = a.ranked.slice(0, top).map((r) => `${r.option} ${pct(r.p)}`).join("   ");
    console.log(`  ${id.padEnd(12)} → ${a.choice.padEnd(14)} conf ${a.confidence.toFixed(2)}   [ ${alts} ]`);
  } else if (a.type === "noul") {
    console.log(`  ${id.padEnd(12)} → P(true) ${pct(a.noul)}`);
  } else {
    console.log(`  ${id.padEnd(12)} → score ${a.score.toFixed(2)}`);
  }
}
const sorted = [...latencies].sort((a, b) => a - b);
const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
console.log(
  runs > 1
    ? `\n  latency over ${runs} runs: p50 ${q(0.5).toFixed(0)} ms · p95 ${q(0.95).toFixed(0)} ms · min ${sorted[0]!.toFixed(0)} ms (first call ${latencies[0]!.toFixed(0)} ms)\n`
    : `\n  latency ${latencies[0]!.toFixed(0)} ms\n`,
);
