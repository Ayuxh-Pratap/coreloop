/**
 * The usage journal (collection half): every push-to-talk press is appended to journal/<date>.jsonl
 * (gitignored, private), with the audio kept for a limited time. Signals that hint something went wrong are
 * worked out automatically and appended as separate lines. Nothing here changes how coreloop behaves; it's the
 * evidence `npm run review` (M7) will read.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface PressEntry {
  type: "press";
  id: string;
  /** epoch ms */
  t: number;
  at: string;
  source: "voice" | "typed";
  /** WAV of the press, relative to the journal folder (absent when audio isn't kept). */
  audio?: string;
  heard: string;
  speech: boolean;
  text: string;
  fixes: string[];
  codeOnly: boolean;
  /** Top 3 per model question, [option, probability %]. */
  model?: { ms: number; answers: Record<string, Array<[string, number]>> };
  outcome: { decision: string; operation?: string; slots?: Record<string, unknown>; reason: string; parts?: string[]; /** the app it was for, and how that was decided */ target?: string };
  /** "no, I meant Claude Code": this press edited the previous command (from → to). A name fix is a mishearing pair. */
  repair?: { kind: string; from: string; to: string };
  plan?: string;
  ran: boolean;
  error?: string;
  ms: { stt?: number; keyUpToText?: number; keyUpToDecision?: number; keyUpToAction?: number; run?: number };
}

export type SignalKind = "undone" | "repeated" | "answered_ask" | "continued_wait" | "declined_confirm" | "flagged" | "two_step" | "no_speech" | "repaired";

export interface SignalLine {
  type: "signal";
  t: number;
  /** id of the press the signal is about */
  ref: string;
  signal: SignalKind;
  detail?: Record<string, unknown>;
}

const CANCEL_LIKE = /^(?:(?:no|nah|nope)(?: .*)?|cancel(?: that)?|never ?mind|forget (?:it|that)|undo(?: that)?|stop|abort|don't.*)$/;

function words(s: string): Set<string> {
  return new Set(s.split(" ").filter((w) => w.length > 1));
}

function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

/**
 * Signals a new press reveals about itself and the presses just before it. Pure, so the rules are testable:
 *   undone           a cancel/undo/no within 5 s after an action ran
 *   declined_confirm a cancel right after a "confirm" prompt
 *   repeated         nearly the same words again within 10 s (the first try probably failed)
 *   answered_ask     what was said within 20 s after an "ask"
 *   continued_wait   what was said within 8 s after a "wait"
 *   two_step         two commands in one sentence
 *   repaired         the previous command was fixed by talking to it ("no, I meant …"): a mishearing to learn
 *   no_speech        a press with no speech in it
 */
export function signalsFor(recent: readonly PressEntry[], cur: PressEntry): SignalLine[] {
  const out: SignalLine[] = [];
  const sig = (ref: string, signal: SignalKind, detail?: Record<string, unknown>) => out.push({ type: "signal", t: cur.t, ref, signal, ...(detail ? { detail } : {}) });
  if (!cur.speech) sig(cur.id, "no_speech");
  if (cur.outcome.parts) sig(cur.id, "two_step", { parts: cur.outcome.parts });
  const prev = recent.at(-1);
  if (cur.repair && prev) sig(prev.id, "repaired", { ...cur.repair });
  if (!prev || !cur.speech) return out;
  const gap = cur.t - prev.t;
  const cancelLike = CANCEL_LIKE.test(cur.text) || cur.outcome.operation === "cancel";
  if (cancelLike && prev.outcome.decision === "confirm" && gap <= 30_000) sig(prev.id, "declined_confirm");
  else if (cancelLike && prev.ran && gap <= 5_000) sig(prev.id, "undone", { by: cur.text });
  if (!cancelLike && gap <= 10_000 && similarity(prev.text, cur.text) >= 0.6) sig(prev.id, "repeated", { then: cur.text });
  if (prev.outcome.decision === "ask" && gap <= 20_000 && !cancelLike) sig(prev.id, "answered_ask", { then: cur.text, operation: cur.outcome.operation });
  if (prev.outcome.decision === "wait" && gap <= 8_000) sig(prev.id, "continued_wait", { then: cur.text });
  return out;
}

/** "that was wrong", "wrong", "that's wrong": marks the previous press as a mistake. */
export const FLAG_PHRASE = /^(?:(?:no )?that(?:'s| was| is) (?:wrong|not (?:right|what i (?:meant|said|wanted)))|wrong)$/;

export interface JournalOptions {
  dir: string;
  /** Days to keep audio; 0 keeps no audio at all. */
  audioDays: number;
}

export const DEFAULT_JOURNAL: JournalOptions = {
  dir: process.env.COLOOP_JOURNAL_DIR ?? "journal",
  audioDays: Number(process.env.COLOOP_AUDIO_DAYS ?? 30),
};

export class Journal {
  readonly opts: JournalOptions;
  private readonly recent: PressEntry[] = [];

  constructor(opts: JournalOptions = DEFAULT_JOURNAL) {
    this.opts = opts;
    mkdirSync(join(opts.dir, "audio"), { recursive: true });
  }

  /** Where to save a press's audio, or undefined when audio isn't kept. Relative to the journal folder. */
  audioPath(id: string): string | undefined {
    return this.opts.audioDays > 0 ? join("audio", `${id}.wav`) : undefined;
  }

  private append(line: PressEntry | SignalLine): void {
    const day = new Date(line.t).toISOString().slice(0, 10);
    appendFileSync(join(this.opts.dir, `${day}.jsonl`), JSON.stringify(line) + "\n");
  }

  /** Appends a press and the signals it produces. Returns the signals. */
  record(entry: PressEntry): SignalLine[] {
    const signals = signalsFor(this.recent, entry);
    this.append(entry);
    for (const s of signals) this.append(s);
    this.recent.push(entry);
    if (this.recent.length > 20) this.recent.shift();
    return signals;
  }

  /** Marks the previous press as wrong ("that was wrong"). */
  flagLast(t: number, said: string): PressEntry | undefined {
    const last = this.recent.at(-1);
    if (last) this.append({ type: "signal", t, ref: last.id, signal: "flagged", detail: { said } });
    return last;
  }

  /** Deletes saved audio older than the retention period. Returns how many files were removed. */
  pruneAudio(now = Date.now()): number {
    const dir = join(this.opts.dir, "audio");
    if (!existsSync(dir)) return 0;
    const cutoff = now - this.opts.audioDays * 86_400_000;
    let removed = 0;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (f.endsWith(".wav") && statSync(p).mtimeMs < cutoff) {
        unlinkSync(p);
        removed++;
      }
    }
    return removed;
  }
}

/** Every line of every journal day, oldest first. */
export function readJournal(dir = DEFAULT_JOURNAL.dir): Array<PressEntry | SignalLine> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as PressEntry | SignalLine));
}
