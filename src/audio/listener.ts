/**
 * Mic + push-to-talk key: hold the key, speak, release. Emits "listening" on key down, "released" the moment the
 * key goes up, and "utterance" once the tail is in, with the recording and the moment the key went up (for
 * key-up → action timing).
 */
import { EventEmitter } from "node:events";
import { PushToTalk } from "./hotkey.ts";
import { listMics, Mic } from "./mic.ts";

export interface Utterance {
  samples: Float32Array;
  /** performance.now() when the key was released. */
  upAt: number;
}

export interface ListenerOptions {
  /** DirectShow mic name; default: COLOOP_MIC, else the first mic Windows lists. */
  mic?: string;
  key?: string;
  prerollMs?: number;
  /** Audio kept after key up, so the last word isn't cut. */
  tailMs?: number;
}

export function defaultMic(): string {
  if (process.env.COLOOP_MIC) return process.env.COLOOP_MIC;
  const mics = listMics();
  if (!mics.length) throw new Error("no microphone found (ffmpeg -list_devices true -f dshow -i dummy)");
  return mics[0]!;
}

export class Listener extends EventEmitter {
  readonly mic: Mic;
  readonly ptt: PushToTalk;
  readonly micName: string;
  private readonly tailMs: number;
  private busy = false;

  constructor(opts: ListenerOptions = {}) {
    super();
    this.micName = opts.mic ?? defaultMic();
    this.mic = new Mic({ device: this.micName, prerollMs: opts.prerollMs ?? 300 });
    this.ptt = new PushToTalk(opts.key);
    this.tailMs = opts.tailMs ?? 150;
    this.ptt.on("down", () => {
      if (this.busy) return;
      this.mic.begin();
      this.emit("listening");
    });
    this.ptt.on("up", async () => {
      if (!this.mic.isCapturing) return;
      const upAt = performance.now();
      this.emit("released");
      this.busy = true;
      const samples = await this.mic.end(this.tailMs);
      this.busy = false;
      this.emit("utterance", { samples, upAt } satisfies Utterance);
    });
  }

  async start(): Promise<void> {
    await this.mic.start();
    this.ptt.start();
  }

  /** Resolves with the next complete utterance. */
  next(): Promise<Utterance> {
    return new Promise((resolve) => this.once("utterance", resolve));
  }

  stop(): void {
    this.ptt.stop();
    this.mic.stop();
  }
}
