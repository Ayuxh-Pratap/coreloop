/**
 * The gate: an accepted change is kept only if every eval set is at least as good after it as before.
 * Each set runs in a fresh process, so it loads the profile as it is on disk at that moment.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { profileDir } from "../host/profile-files.ts";
import { fileURLToPath } from "node:url";

/** Every set the core is measured on. */
export const GATE_SETS = ["desktop", "desktop-holdout", "personal", "daily", "daily-holdout", "browser", "workflow", "workflow-holdout", "nested", "nested-holdout"] as const;

export interface SetScore {
  set: string;
  /** Cases or turns. */
  of: number;
  /** Not right: a failed case, or a wrong or asked turn. */
  misses: number;
  /** Wrong actions (conversations only; a failed single sentence counts here too). */
  wrong: number;
}

/** The score in an eval run's output. */
export function parseScore(set: string, output: string): SetScore {
  const single = /PIPELINE pass (\d+)\/(\d+)/.exec(output);
  if (single) {
    const of = Number(single[2]);
    const misses = of - Number(single[1]);
    return { set, of, misses, wrong: misses };
  }
  const conv = /WRONG (\d+)\/(\d+) .*?right (\d+)/.exec(output);
  if (conv) return { set, of: Number(conv[2]), misses: Number(conv[2]) - Number(conv[3]), wrong: Number(conv[1]) };
  throw new Error(`no score in the output of the ${set} eval`);
}

/** Why `after` is worse than `before`, set by set; empty when nothing got worse. */
export function worse(before: readonly SetScore[], after: readonly SetScore[]): string[] {
  const out: string[] = [];
  for (const a of after) {
    const b = before.find((x) => x.set === a.set);
    if (!b) continue;
    if (a.wrong > b.wrong) out.push(`${a.set}: wrong ${b.wrong} → ${a.wrong}`);
    else if (a.misses > b.misses) out.push(`${a.set}: not right ${b.misses} → ${a.misses}`);
  }
  return out;
}

const EVAL = fileURLToPath(new URL("../cli/eval.ts", import.meta.url));

/** Runs one eval set in its own process. */
export function runSet(set: string): Promise<SetScore> {
  return new Promise((resolve, reject) => {
    // the gate checks my profile (with the proposals accepted), not the evals' fixture
    execFile(process.execPath, [EVAL, set], { maxBuffer: 20_000_000, env: { ...process.env, COLOOP_PROFILE_DIR: profileDir() } }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${set} eval failed: ${stderr || err.message}`));
      try {
        resolve(parseScore(set, stdout));
      } catch (e) {
        reject(e as Error);
      }
    });
  });
}

/** Every set, one after another (they share the GPU). */
export async function runAll(onEach?: (s: SetScore) => void): Promise<SetScore[]> {
  const out: SetScore[] = [];
  // a set that isn't on this machine (my personal set on a fresh clone) is skipped
  for (const set of GATE_SETS.filter((s) => existsSync(join("eval", `${s}.json`)) || existsSync(join("eval", `${s}.jsonl`)))) {
    const s = await runSet(set);
    onEach?.(s);
    out.push(s);
  }
  return out;
}
