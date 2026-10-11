/**
 * The live loop (M6): hold Right Ctrl, speak, release, and the core handles it.
 *   key down  → mic keeps audio; a tiny warm-up request wakes the model while you speak
 *   key up    → VAD + Parakeet → pipeline → plan → run on the connected surface
 *   every press → journal/<date>.jsonl (+ audio for 30 days), with automatic signals
 *
 * On main the surface is the simulated desktop: your real voice, the real core, and a desktop that exists only
 * in the simulation, so nothing on this machine changes. The Windows surface lives on the `windows` branch.
 *
 *   npm run live
 *   npm run live -- --open "Cursor,Spotify" --front Spotify --host Cursor
 *   npm run live -- --no-audio --mic "…" --key F9
 *
 * Say "that was wrong" to mark the previous command as a mistake in the journal. Ctrl+C to stop.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Listener, type Utterance } from "../audio/listener.ts";
import { readWav, SAMPLE_RATE, SpeechToText } from "../audio/stt.ts";
import { writeWav } from "../audio/wav.ts";
import { CODE_ONLY } from "../backends/codeonly.ts";
import { startDecider } from "../host/decider.ts";
import { config } from "../config.ts";
import { useProfileFiles } from "../host/profile-files.ts";
import { normalise } from "../core/normalise.ts";
import { buildRequest } from "../core/questions.ts";
import { DEFAULT_JOURNAL, FLAG_PHRASE, Journal, type PressEntry } from "../journal/journal.ts";
import { Actor, describe, type ActResult } from "../live/actor.ts";
import { fixtureDesktop } from "../sim/fixture.ts";

// the person's profile (mishearings, phrases, nicknames, actions turned off), handed to the engine
useProfileFiles();

const { values } = parseArgs({
  options: {
    open: { type: "string" },
    front: { type: "string" },
    host: { type: "string" },
    "no-audio": { type: "boolean", default: false },
    inject: { type: "string", multiple: true },
    mic: { type: "string" },
    key: { type: "string" },
    "no-model": { type: "boolean", default: false },
  },
});

// the model while it answers, code only while it doesn't; --no-model for code only from the start
const client = await startDecider({ noModel: values["no-model"] });
const stt = new SpeechToText();
const open = values.open?.split(",").map((x) => x.trim()).filter(Boolean);
const sim = fixtureDesktop(open ? { open, foreground: values.front ?? open[0], host: values.host } : undefined);
const actor = new Actor({ client, surface: sim });
// Injected test runs keep their own journal, so test data never mixes with real use.
const journal = new Journal({
  dir: values.inject ? join("runs", "inject-journal") : DEFAULT_JOURNAL.dir,
  audioDays: values["no-audio"] ? 0 : DEFAULT_JOURNAL.audioDays,
});
const pruned = journal.pruneAudio();
const listener = new Listener({ mic: values.mic, key: values.key });

/** A surface would show this (a notification, an overlay); here it's the terminal line printed below. */
const notify = (_title: string, _body: string) => {};

// Keep the GPU awake while the user speaks: a laptop GPU drops its clock within about a second of idling, which
// made the real request 2-3x slower. Ping on key down, every 500 ms while held, and once at release (that last
// one runs alongside speech-to-text on the CPU).
const warmRequest = buildRequest("warm up");
const warm = () => void client.decide(warmRequest).catch(() => {});
let keepWarm: ReturnType<typeof setInterval> | undefined;
listener.on("listening", () => {
  process.stdout.write("● ");
  warm();
  keepWarm = setInterval(warm, 500);
});
listener.on("released", () => {
  clearInterval(keepWarm);
  warm();
  actor.prefetch(); // what's in use and open, read while speech-to-text runs
});

// One utterance at a time, in order.
let queue: Promise<void> = Promise.resolve();
listener.on("utterance", (u: Utterance) => {
  queue = queue.then(() => handle(u)).catch((err) => console.error(`\n✖ ${(err as Error).message}`));
});

async function handle({ samples, upAt }: Utterance): Promise<void> {
  const t = stt.transcribe(samples);
  const heardAt = performance.now();
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const audio = journal.audioPath(id);
  if (audio) writeWav(join(journal.opts.dir, audio), samples, SAMPLE_RATE);

  const entry: Omit<PressEntry, "text" | "fixes" | "codeOnly" | "outcome" | "ran"> = {
    type: "press",
    id,
    t: Date.now(),
    at: new Date().toISOString(),
    source: "voice",
    audio,
    heard: t.text,
    speech: t.speech,
    ms: { stt: Math.round(t.vadMs + t.sttMs), keyUpToText: Math.round(heardAt - upAt) },
  };

  if (!t.speech) {
    journal.record({ ...entry, text: "", fixes: [], codeOnly: true, outcome: { decision: "ignore", reason: "no speech" }, ran: false });
    console.log("(no speech)");
    return;
  }

  const said = normalise(t.text).text;
  if (FLAG_PHRASE.test(said)) {
    const last = journal.flagLast(Date.now(), t.text);
    console.log(`"${t.text}" → noted: ${last ? `"${last.heard}" marked wrong` : "nothing to mark"}`);
    notify("Noted", last ? `Marked "${last.heard}" as wrong.` : "Nothing to mark yet.");
    return;
  }

  const r: ActResult = await actor.handle(t.text);
  sim.afterTurn();
  const decidedAt = performance.now();
  const u = r.understood;
  const o = r.outcome;
  // without the model (or while it is down) the decider answers nothing: that turn is code only, not a 0 ms model call
  const model = u.decision?.model === CODE_ONLY ? undefined : u.decision;
  const signals = journal.record({
    ...entry,
    text: u.norm.text,
    fixes: u.norm.fixes,
    codeOnly: !model,
    model: model
      ? {
          ms: Math.round(model.latencyMs),
          answers: Object.fromEntries(
            Object.entries(model.answers).flatMap(([k, a]) => (a.type === "choice" ? [[k, a.ranked.slice(0, 3).map((x) => [x.option, Math.round(x.p * 1000) / 10] as [string, number])]] : [])),
          ),
        }
      : undefined,
    outcome: {
      decision: o.decision,
      operation: "operation" in o ? o.operation : undefined,
      slots: "slots" in o ? { ...o.slots } : undefined,
      reason: o.reason,
      parts: o.decision === "ask" ? o.parts : undefined,
      target: u.scope.target ? `${u.scope.target.app} (${u.scope.target.via})` : undefined,
    },
    repair: r.repair,
    plan: r.plan ? r.plan.summary + (r.notes?.length ? ` → ${r.notes.join(". ")}` : "") : undefined,
    ran: r.ran,
    error: r.runError ?? r.planError,
    ms: {
      ...entry.ms,
      keyUpToDecision: Math.round(decidedAt - upAt),
      keyUpToAction: r.startedAt ? Math.round(r.startedAt - upAt) : undefined,
      run: r.runMs ? Math.round(r.runMs) : undefined,
    },
  });

  const line = describe(r);
  const timing = r.startedAt ? `key-up → action ${(r.startedAt - upAt).toFixed(0)} ms` : `key-up → decision ${(decidedAt - upAt).toFixed(0)} ms`;
  const mark = r.pending ? "⚠" : r.runError || r.planError ? "✖" : r.ran ? "✔" : "·";
  console.log(`"${t.text}"\n  ${mark} ${line}   · ${o.reason} · ${timing}${signals.length ? `   [journal: ${signals.map((s) => s.signal).join(", ")}]` : ""}`);
  notify(`“${t.text}”`, line);
}

if (values.inject) {
  // Development: feed recordings through the exact live path (warm-up while "speaking", STT, actor, journal,
  // notification) without a microphone. Each file plays the part of one push-to-talk press.
  console.log(`injecting ${values.inject.length} recording(s) · ${sim.name} · journal: ${journal.opts.dir}/`);
  for (const file of values.inject) {
    const samples = readWav(file);
    listener.emit("listening");
    await new Promise((r) => setTimeout(r, Math.max(800, (samples.length / SAMPLE_RATE) * 1000))); // the time it took to say it
    listener.emit("released");
    await new Promise((r) => setTimeout(r, 150)); // the tail a real release keeps
    queue = queue.then(() => handle({ samples, upAt: performance.now() - 150 }));
    await queue;
  }
  process.exit(0);
}

await listener.start();
console.log(
  `coreloop live · ${sim.name} (nothing on this machine changes) · in front: ${sim.foreground?.title ?? "nothing"} · mic "${listener.micName}" · hold ${listener.ptt.keyName} and speak · Ctrl+C to stop`,
);
console.log(`${sim.host ? `simulated: coreloop runs inside ${sim.host}, whose window never counts as the app in use · ` : ""}${sim.apps.length} apps · speech-to-text loaded in ${stt.loadMs.toFixed(0)} ms · journal: ${journal.opts.dir}/ (audio ${journal.opts.audioDays ? `kept ${journal.opts.audioDays} days` : "not kept"}${pruned ? `, ${pruned} old recordings removed` : ""})`);
console.log('say "that was wrong" to mark the last command as a mistake\n');
notify("coreloop is listening", `Hold ${listener.ptt.keyName} and speak.`);

process.on("SIGINT", () => {
  listener.stop();
  console.log("\nstopped");
  process.exit(0);
});
