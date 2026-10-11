/**
 * Summary of real usage from the journal: how fast, what happened, and where it probably went wrong.
 *   npm run journal                 everything
 *   npm run journal -- --days 1     the last 24 hours
 *
 * This only reads. Turning these findings into proposed fixes is `npm run review` (M7).
 */
import { parseArgs } from "node:util";
import { percentile } from "../eval/score.ts";
import { DEFAULT_JOURNAL, readJournal, type PressEntry, type SignalLine } from "../journal/journal.ts";

const { values } = parseArgs({ options: { days: { type: "string" }, dir: { type: "string" } } });
const since = values.days ? Date.now() - Number(values.days) * 86_400_000 : 0;
const lines = readJournal(values.dir ?? DEFAULT_JOURNAL.dir).filter((l) => l.t >= since);
const presses = lines.filter((l): l is PressEntry => l.type === "press");
const signals = lines.filter((l): l is SignalLine => l.type === "signal");
if (!presses.length) {
  console.log("journal is empty. Use coreloop with: npm run live");
  process.exit(0);
}

const count = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};
const stat = (xs: Array<number | undefined>) => {
  const v = xs.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  return v.length ? `p50 ${percentile(v, 0.5)} ms · p95 ${percentile(v, 0.95)} ms (${v.length})` : "n/a";
};

const spoken = presses.filter((p) => p.speech);
const first = new Date(presses[0]!.t).toLocaleString();
const last = new Date(presses.at(-1)!.t).toLocaleString();
console.log(`\n${presses.length} presses (${spoken.length} with speech) · ${first} → ${last}\n`);

console.log("TIMING");
console.log(`  key-up → text      ${stat(spoken.map((p) => p.ms.keyUpToText))}`);
console.log(`  key-up → decision  ${stat(spoken.map((p) => p.ms.keyUpToDecision))}`);
console.log(`  key-up → action    ${stat(spoken.map((p) => p.ms.keyUpToAction))}   (M6 target: p50 ≤ 800 ms)`);

console.log("\nOUTCOMES");
console.log(`  ${count(spoken, (p) => p.outcome.decision).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
console.log(`  ran ${spoken.filter((p) => p.ran).length} · errors ${spoken.filter((p) => p.error).length} · decided by code alone ${spoken.filter((p) => p.codeOnly).length}`);
const ops = count(spoken.filter((p) => p.outcome.operation), (p) => p.outcome.operation!);
if (ops.length) console.log(`  operations: ${ops.map(([k, n]) => `${k} ${n}`).join(" · ")}`);
const fixes = count(spoken.flatMap((p) => p.fixes), (f) => f);
if (fixes.length) console.log(`  speech-to-text fixes applied: ${fixes.map(([k, n]) => `${k} ×${n}`).join(" · ")}`);

console.log("\nSIGNALS (hints that something went wrong)");
const bySignal = count(signals, (s) => s.signal);
console.log(bySignal.length ? `  ${bySignal.map(([k, n]) => `${k} ${n}`).join(" · ")}` : "  none");
const byId = new Map(presses.map((p) => [p.id, p]));
const worrying = signals.filter((s) => s.signal !== "no_speech").slice(-15);
for (const s of worrying) {
  const p = byId.get(s.ref);
  const then = s.detail && "then" in s.detail ? `  → then “${String(s.detail.then)}”` : "";
  console.log(`  ${s.signal.padEnd(16)} “${p?.heard ?? s.ref}” (${p?.outcome.decision ?? "?"}${p?.outcome.operation ? ` ${p.outcome.operation}` : ""})${then}`);
}

console.log("\nWHAT YOU SAY MOST");
for (const [text, n] of count(spoken, (p) => p.text).slice(0, 10)) console.log(`  ${String(n).padStart(3)}×  ${text}`);
console.log("");
