/**
 * Prints the newest run (runs/LATEST) as a readable timeline.
 *   npm run last-run
 *   npm run last-run -- runs/2026-10-03T10-00-00-000Z     a specific run
 */
import { latestRunDir, readEvents } from "../recorder/recorder.ts";

const dir = process.argv[2] ?? latestRunDir();
if (!dir) {
  console.error("no runs yet (runs/ is empty)");
  process.exit(1);
}

const fmt = (ms: number) => `${(ms / 1000).toFixed(2).padStart(7)} s`;
console.log(`run ${dir}\n`);
for (const e of readEvents(dir)) {
  const { t, type, ...rest } = e;
  let line: string;
  switch (type) {
    case "utterance":
      line = `🎙  "${rest.raw}"`;
      break;
    case "decision": {
      const answers = rest.answers as Record<string, { choice?: string; p?: number }>;
      const picks = Object.entries(answers).map(([k, a]) => `${k}=${a.choice}${a.p !== undefined ? ` ${(a.p * 100).toFixed(0)}%` : ""}`).join("  ");
      line = `   "${rest.text}"  ${picks}  (${rest.modelMs} ms)`;
      break;
    }
    case "outcome":
      line = `   → ${String(rest.decision).toUpperCase()}${rest.operation ? ` ${rest.operation}` : ""}  · ${rest.reason}`;
      break;
    default:
      line = `${type} ${JSON.stringify(rest)}`;
  }
  console.log(`${fmt(t)}  ${line}`);
}
