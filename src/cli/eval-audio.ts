/**
 * Audio eval: every recording of eval/audio/prompts.jsonl goes through VAD → Parakeet → the full pipeline, and is
 * scored three ways: word error rate (heard vs meant), speech-to-text latency, and pipeline correctness (same
 * scoring as `npm run eval`, on the fixture desktop).
 *
 *   npm run eval:audio                    your recordings (eval/audio/recordings, from npm run record-voice)
 *   npm run eval:audio -- --tts           synthetic recordings made with the Windows voice (runs/tts-audio)
 *   npm run eval:audio -- --dir <folder>  any folder of <id>.wav files
 *
 * Without the model server it still reports speech-to-text; start it (npm run models:start) for pipeline scores.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readWav, SAMPLE_RATE, SpeechToText } from "../audio/stt.ts";
import { wordErrorRate } from "../audio/wer.ts";
import { SystemOneClient, type Decider } from "../backends/systemone.ts";
import { CodeOnlyDecider } from "../backends/codeonly.ts";
import { config } from "../config.ts";
import { evalProfileDir, useProfileFiles } from "../host/profile-files.ts";
import { understand } from "../core/pipeline.ts";
import { fixtureApps, fixtureDesktop } from "../sim/fixture.ts";
import { SIM_SKILLS } from "../sim/skills.ts";
import { SkillSet } from "../skills/skillset.ts";
import { PlanError } from "../surface/contract.ts";
import { parseCases, percentile, scorePipeline, type EvalCase, type PipelineResult } from "../eval/score.ts";

// the evals' fixture profile (eval/profile/), or the one named by COLOOP_PROFILE_DIR
useProfileFiles(evalProfileDir());

const { values } = parseArgs({ options: { dir: { type: "string" }, tts: { type: "boolean", default: false }, "no-model": { type: "boolean", default: false } } });

const prompts = parseCases(readFileSync(join("eval", "audio", "prompts.jsonl"), "utf8"), "eval/audio/prompts.jsonl");
const dir = values.dir ?? (values.tts ? join("runs", "tts-audio") : join("eval", "audio", "recordings"));

/** Makes the missing synthetic recordings with the Windows speech synthesizer, 16 kHz mono. */
function synthesize(cases: EvalCase[], outDir: string): void {
  const missing = cases.filter((c) => !existsSync(join(outDir, `${c.id}.wav`)));
  if (!missing.length) return;
  mkdirSync(outDir, { recursive: true });
  const list = join(outDir, "texts.json");
  writeFileSync(list, JSON.stringify(missing.map((c) => ({ path: resolve(outDir, `${c.id}.wav`), text: c.said }))));
  const ps = [
    "Add-Type -AssemblyName System.Speech",
    `$items = Get-Content -Raw -Encoding UTF8 '${resolve(list)}' | ConvertFrom-Json`,
    "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
    "foreach ($i in $items) { $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile($i.path, $fmt); $s.Speak($i.text); $s.Dispose() }",
  ].join("\n");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`speech synthesis failed: ${r.stderr}`);
  console.log(`synthesized ${missing.length} recordings into ${outDir}`);
}

if (values.tts) synthesize(prompts, dir);
const cases = prompts.filter((c) => existsSync(join(dir, `${c.id}.wav`)));
if (!cases.length) {
  console.error(`no recordings in ${dir}. Record them with: npm run record-voice  (or try --tts)`);
  process.exit(1);
}

const stt = new SpeechToText();
// --no-model: no-model mode, code decides what it can and the rest is asked
const noModel = values["no-model"];
const http = new SystemOneClient({ baseUrl: config.decider.url, timeoutMs: config.decider.timeoutMs });
const client: Decider = noModel ? new CodeOnlyDecider() : http;
const withPipeline = noModel || (await http.health()).ok;
const apps = fixtureApps();
const skills = new SkillSet(SIM_SKILLS);
const desktop = fixtureDesktop();
if (withPipeline) for (let i = 0; i < 2; i++) await understand(client, "warm up", { ctx: { apps, skills } });

interface Row {
  id: string;
  said: string;
  heard: string;
  wer: number;
  errors: number;
  words: number;
  audioSec: number;
  sttMs: number;
  vadMs: number;
  pipeline?: PipelineResult;
  decideMs?: number;
}
const rows: Row[] = [];
const pad = new Float32Array(Math.round((values.tts ? 0.5 : 0) * SAMPLE_RATE));
for (const c of cases) {
  const raw = readWav(join(dir, `${c.id}.wav`));
  const samples = new Float32Array(pad.length * 2 + raw.length); // synthetic takes get the silence a real key press has
  samples.set(raw, pad.length);
  const t = stt.transcribe(samples);
  const w = wordErrorRate(c.said, t.text);
  const row: Row = { id: c.id, said: c.said, heard: t.text, wer: w.wer, errors: w.errors, words: w.words, audioSec: t.audioSec, sttMs: t.sttMs, vadMs: t.vadMs };
  if (withPipeline) {
    const u = await understand(client, t.text, { ctx: { apps, skills } });
    const scored = scorePipeline(c, u.outcome);
    if (u.outcome.decision === "act" || u.outcome.decision === "confirm") {
      try {
        desktop.plan(u.outcome);
      } catch (err) {
        if (!(err instanceof PlanError)) throw err;
        scored.fields.push({ field: "plan", expected: "ok", got: err.message, ok: false, p: 1 });
        scored.pass = false;
      }
    }
    row.pipeline = scored;
    row.decideMs = u.totalMs;
  }
  rows.push(row);
}

const sum = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
const sorted = (f: (r: Row) => number) => rows.map(f).sort((a, b) => a - b);
const stt50 = percentile(sorted((r) => r.sttMs + r.vadMs), 0.5);
const stt95 = percentile(sorted((r) => r.sttMs + r.vadMs), 0.95);
const exact = rows.filter((r) => r.errors === 0).length;
const totalWer = sum((r) => r.errors) / Math.max(1, sum((r) => r.words));

console.log(`\n=== audio · ${dir} · ${rows.length} recordings${values.tts ? " (synthetic Windows voice)" : ""} ===`);
console.log(`SPEECH   word error rate ${(totalWer * 100).toFixed(1)}% · exact ${exact}/${rows.length} · VAD+STT p50 ${stt50.toFixed(0)} ms · p95 ${stt95.toFixed(0)} ms`);
console.log(`         key-up → text ≈ 150 ms tail + VAD+STT ≈ ${(150 + stt50).toFixed(0)} ms (p50)`);
if (withPipeline) {
  const passed = rows.filter((r) => r.pipeline!.pass).length;
  const unsafe = rows.filter((r) => r.pipeline!.unsafe).length;
  const total50 = percentile(sorted((r) => 150 + r.vadMs + r.sttMs + (r.decideMs ?? 0)), 0.5);
  console.log(`PIPELINE pass ${passed}/${rows.length} (${((100 * passed) / rows.length).toFixed(1)}%) · destructive without confirm: ${unsafe}`);
  console.log(`         key-up → decision ≈ ${total50.toFixed(0)} ms (p50: tail + VAD + STT + pipeline)`);
} else {
  console.log("PIPELINE skipped: model server not running (npm run models:start)");
}
console.log("");
for (const r of rows) {
  const p = r.pipeline ? (r.pipeline.pass ? "✔" : "✖") : " ";
  const why = r.pipeline && !r.pipeline.pass ? `  [${r.pipeline.fields.filter((f) => !f.ok).map((f) => `${f.field}: ${f.expected} → ${f.got}`).join("; ")}]` : "";
  const heard = r.errors ? `heard “${r.heard}” (${r.errors} wrong word${r.errors > 1 ? "s" : ""})` : "exact";
  console.log(`${p} ${r.id.padEnd(12)} ${(r.sttMs + r.vadMs).toFixed(0).padStart(4)} ms  “${r.said}” → ${heard}${why}`);
}

mkdirSync(join("runs", "eval"), { recursive: true });
writeFileSync(join("runs", "eval", `${new Date().toISOString().replace(/[:.]/g, "-")}-audio.json`), JSON.stringify({ dir, rows }, null, 2));
