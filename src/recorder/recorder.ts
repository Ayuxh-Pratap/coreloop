/**
 * Run recorder: every run writes runs/<time>/events.jsonl (gitignored), one JSON event per line, so any
 * decision can be replayed and explained later (`npm run last-run`). runs/LATEST names the newest run.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RunEvent {
  /** ms since the run started */
  t: number;
  type: string;
  [key: string]: unknown;
}

export class Recorder {
  readonly dir: string;
  private readonly file: string;
  private readonly start = performance.now();

  constructor(root = "runs", meta: Record<string, unknown> = {}) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.dir = join(root, stamp);
    this.file = join(this.dir, "events.jsonl");
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(root, "LATEST"), stamp);
    this.event("run_start", { at: new Date().toISOString(), ...meta });
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    const e: RunEvent = { t: Math.round(performance.now() - this.start), type, ...data };
    appendFileSync(this.file, JSON.stringify(e) + "\n");
  }
}

export function latestRunDir(root = "runs"): string | undefined {
  try {
    return join(root, readFileSync(join(root, "LATEST"), "utf8").trim());
  } catch {
    const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== "eval").map((d) => d.name).sort();
    return dirs.length ? join(root, dirs.at(-1)!) : undefined;
  }
}

export function readEvents(dir: string): RunEvent[] {
  return readFileSync(join(dir, "events.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunEvent);
}
