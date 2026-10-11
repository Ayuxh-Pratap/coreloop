/**
 * Guided recording of the audio test set: for each prompt in eval/audio/prompts.jsonl, hold the push-to-talk key,
 * say the sentence, release. Each take is saved as eval/audio/recordings/<id>.wav (gitignored: it's your voice).
 *
 *   npm run record-voice                  record every prompt that has no recording yet
 *   npm run record-voice -- --redo        record all of them again
 *   npm run record-voice -- --mic "…" --key F9
 *
 * After each take you see what was heard; press Enter to keep it, r to redo, s to skip, q to stop.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { Listener } from "../audio/listener.ts";
import { SAMPLE_RATE, SpeechToText } from "../audio/stt.ts";
import { writeWav } from "../audio/wav.ts";
import { wordErrorRate } from "../audio/wer.ts";
import { parseCases } from "../eval/score.ts";

const { values } = parseArgs({ options: { mic: { type: "string" }, key: { type: "string" }, redo: { type: "boolean", default: false } } });

const OUT = join("eval", "audio", "recordings");
const prompts = parseCases(readFileSync(join("eval", "audio", "prompts.jsonl"), "utf8"), "eval/audio/prompts.jsonl");
const todo = prompts.filter((p) => values.redo || !existsSync(join(OUT, `${p.id}.wav`)));
if (!todo.length) {
  console.log(`all ${prompts.length} prompts are recorded (use --redo to record again). Next: npm run eval:audio`);
  process.exit(0);
}
mkdirSync(OUT, { recursive: true });

const stt = new SpeechToText();
const listener = new Listener({ mic: values.mic, key: values.key });
await listener.start();
const rl = createInterface({ input: process.stdin, output: process.stdout });
writeFileSync(join(OUT, "session.json"), JSON.stringify({ mic: listener.micName, key: listener.ptt.keyName, at: new Date().toISOString() }, null, 2));

console.log(`Recording ${todo.length} of ${prompts.length} prompts on "${listener.micName}".`);
console.log(`For each one: hold ${listener.ptt.keyName}, say the sentence the way you normally would, release.\n`);

let saved = 0;
outer: for (const [i, p] of todo.entries()) {
  for (;;) {
    console.log(`[${i + 1}/${todo.length}] Say:  “${p.said}”`);
    const u = await listener.next();
    const t = stt.transcribe(u.samples);
    const { wer } = wordErrorRate(p.said, t.text);
    console.log(`   heard: “${t.text || "(no speech)"}”  · ${t.audioSec.toFixed(1)} s · ${wer === 0 ? "exact" : `${(wer * 100).toFixed(0)}% word error`}`);
    const a = (await rl.question("   Enter = keep · r = redo · s = skip · q = stop  ")).trim().toLowerCase();
    if (a === "q") break outer;
    if (a === "s") break;
    if (a === "r") continue;
    writeWav(join(OUT, `${p.id}.wav`), u.samples, SAMPLE_RATE);
    saved++;
    break;
  }
}
rl.close();
listener.stop();
console.log(`\nsaved ${saved} recording(s) to ${OUT}. Score them with: npm run eval:audio`);
process.exit(0);
