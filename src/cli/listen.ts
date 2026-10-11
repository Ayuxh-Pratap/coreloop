/**
 * Hold a key, speak, release: prints what was heard and how long it took. With --pipeline it also shows what
 * coreloop would do on the simulated desktop (it needs the model server), without doing it.
 *
 *   npm run listen                         hold Right Ctrl and speak (works with any app in front)
 *   npm run listen -- --pipeline           also show the decision and the plan (nothing runs)
 *   npm run listen -- --list-mics          microphones Windows knows about
 *   npm run listen -- --mic "Microphone Array (Realtek(R) Audio)" --key F9
 *   npm run listen -- --save runs/audio    keep each recording as a WAV
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Listener, type Utterance } from "../audio/listener.ts";
import { listMics } from "../audio/mic.ts";
import { SAMPLE_RATE, SpeechToText } from "../audio/stt.ts";
import { writeWav } from "../audio/wav.ts";
import { SystemOneClient } from "../backends/systemone.ts";
import { config } from "../config.ts";
import { useProfileFiles } from "../host/profile-files.ts";
import type { AppEntry } from "../core/apps.ts";
import { understand } from "../core/pipeline.ts";
import { Session } from "../core/policy.ts";
import { fixtureDesktop } from "../sim/fixture.ts";
import type { SimDesktop } from "../sim/desktop.ts";
import { SkillSet } from "../skills/skillset.ts";
import { PlanError } from "../surface/contract.ts";
import { Recorder } from "../recorder/recorder.ts";

// the person's profile (mishearings, phrases, nicknames, actions turned off), handed to the engine
useProfileFiles();

const { values } = parseArgs({
  options: {
    mic: { type: "string" },
    key: { type: "string" },
    pipeline: { type: "boolean", default: false },
    save: { type: "string" },
    "list-mics": { type: "boolean", default: false },
  },
});

if (values["list-mics"]) {
  listMics().forEach((m, i) => console.log(`${i === 0 ? "* " : "  "}${m}`));
  console.log("\n* = default (override with --mic or COLOOP_MIC)");
  process.exit(0);
}

const stt = new SpeechToText();
const listener = new Listener({ mic: values.mic, key: values.key });
const rec = new Recorder("runs", { source: "listen", mic: listener.micName, key: listener.ptt.keyName, pipeline: values.pipeline });

let client: SystemOneClient | undefined;
let sim: SimDesktop | undefined;
let apps: readonly AppEntry[] = [];
let skills = new SkillSet();
let session = new Session();
if (values.pipeline) {
  client = new SystemOneClient({ baseUrl: config.decider.url, timeoutMs: config.decider.timeoutMs });
  if (!(await client.health()).ok) {
    console.error(`model server not reachable at ${config.decider.url}. Start it (npm run models:start) or drop --pipeline`);
    process.exit(1);
  }
  // decisions are shown against the simulated desktop: nothing on this machine changes
  sim = fixtureDesktop();
  apps = sim.apps;
  skills = new SkillSet(sim.skills);
  session = new Session(skills);
}
if (values.save) mkdirSync(values.save, { recursive: true });

await listener.start();
console.log(`listening on "${listener.micName}" · hold ${listener.ptt.keyName} and speak · Ctrl+C to quit`);
console.log(`speech-to-text loaded in ${stt.loadMs.toFixed(0)} ms${values.pipeline ? ` · ${apps.length} apps · decisions shown, nothing runs` : ""}\n`);

listener.on("listening", () => process.stdout.write("● "));
listener.on("utterance", async ({ samples, upAt }: Utterance) => {
  const t = stt.transcribe(samples);
  const heardAt = performance.now();
  if (values.save) writeWav(join(values.save, `${new Date().toISOString().replace(/[:.]/g, "-")}.wav`), samples, SAMPLE_RATE);
  rec.event("heard", { text: t.text, speech: t.speech, audioSec: t.audioSec, vadMs: Math.round(t.vadMs), sttMs: Math.round(t.sttMs), keyUpToTextMs: Math.round(heardAt - upAt) });
  if (!t.speech) {
    console.log(`(no speech in ${t.audioSec.toFixed(1)} s)`);
    return;
  }
  console.log(`"${t.text}"   · ${t.audioSec.toFixed(1)} s audio · speech-to-text ${t.sttMs.toFixed(0)} ms · key-up → text ${(heardAt - upAt).toFixed(0)} ms`);
  if (!client || !sim) return;
  const u = await understand(client, t.text, { ctx: { apps, skills } });
  const outcome = session.handle(u.outcome);
  const decidedAt = performance.now();
  let plan = "";
  if (outcome.decision === "act" || outcome.decision === "confirm") {
    try {
      plan = sim.plan(outcome).summary;
    } catch (err) {
      plan = err instanceof PlanError ? `can't: ${err.message}` : String(err);
    }
  }
  rec.event("outcome", { ...outcome, plan, keyUpToDecisionMs: Math.round(decidedAt - upAt) });
  console.log(`  ${outcome.decision.toUpperCase()} · ${outcome.reason}${plan ? ` · would ${plan}` : ""} · key-up → decision ${(decidedAt - upAt).toFixed(0)} ms`);
});

process.on("SIGINT", () => {
  listener.stop();
  console.log(`\nrecorded: ${rec.dir}`);
  process.exit(0);
});
