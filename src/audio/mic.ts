/**
 * Microphone capture through ffmpeg (DirectShow on Windows): 16 kHz mono 16-bit PCM streamed into Node. No
 * native audio module to build.
 *
 * The mic stays open while the app runs and keeps the last `prerollMs` of audio, so a word spoken a moment before
 * the key went down isn't clipped. Nothing is kept or sent anywhere unless `begin()`…`end()` asks for it.
 * (Windows shows its "microphone in use" indicator for as long as the mic is open.)
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { SAMPLE_RATE } from "./stt.ts";

export interface MicOptions {
  /** DirectShow device name, e.g. "Microphone Array (Realtek(R) Audio)". */
  device: string;
  prerollMs: number;
  /** Test source instead of a microphone: an ffmpeg lavfi spec such as "sine=frequency=440". */
  testSource?: string;
}

/** Audio capture devices DirectShow knows about, in the order ffmpeg lists them. */
export function listMics(): string[] {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], { encoding: "utf8" });
  const out = `${r.stdout}${r.stderr}`;
  return [...out.matchAll(/"([^"]+)" \(audio\)/g)].map((m) => m[1]!);
}

export class Mic extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private ring: Float32Array;
  private ringPos = 0;
  private ringFull = false;
  private capturing: Float32Array[] | undefined;
  private leftover: Buffer = Buffer.alloc(0);
  private readonly opts: MicOptions;

  constructor(opts: MicOptions) {
    super();
    this.opts = opts;
    this.ring = new Float32Array(Math.round((opts.prerollMs / 1000) * SAMPLE_RATE));
  }

  /** Opens the device and resolves once audio is flowing. */
  start(timeoutMs = 5000): Promise<void> {
    const input = this.opts.testSource ? ["-re", "-f", "lavfi", "-i", this.opts.testSource] : ["-f", "dshow", "-audio_buffer_size", "30", "-i", `audio=${this.opts.device}`];
    const proc = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...input, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += String(d)));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no audio from "${this.opts.device}" after ${timeoutMs} ms ${stderr.trim()}`)), timeoutMs);
      proc.stdout.on("data", (chunk: Buffer) => {
        clearTimeout(timer);
        this.onPcm(chunk);
        resolve();
      });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        this.proc = undefined;
        if (code) reject(new Error(`ffmpeg exited (${code}): ${stderr.trim()}`));
        this.emit("close", code);
      });
    });
  }

  private onPcm(chunk: Buffer): void {
    const buf = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk;
    const n = Math.floor(buf.length / 2);
    this.leftover = buf.subarray(n * 2);
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(i * 2) / 0x8000;
    if (this.capturing) this.capturing.push(samples);
    for (const s of samples) {
      this.ring[this.ringPos] = s;
      this.ringPos = (this.ringPos + 1) % this.ring.length;
      if (this.ringPos === 0) this.ringFull = true;
    }
  }

  private preroll(): Float32Array {
    if (!this.ringFull) return this.ring.slice(0, this.ringPos);
    const out = new Float32Array(this.ring.length);
    out.set(this.ring.subarray(this.ringPos));
    out.set(this.ring.subarray(0, this.ringPos), this.ring.length - this.ringPos);
    return out;
  }

  /** Key down: start keeping audio, beginning with the pre-roll. */
  begin(): void {
    this.capturing = [this.preroll()];
  }

  get isCapturing(): boolean {
    return this.capturing !== undefined;
  }

  /** Key up: keep `tailMs` more (the end of the last word), then return everything since begin(). */
  async end(tailMs = 150): Promise<Float32Array> {
    await new Promise((r) => setTimeout(r, tailMs));
    const parts = this.capturing ?? [];
    this.capturing = undefined;
    const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  stop(): void {
    this.capturing = undefined;
    this.proc?.kill();
    this.proc = undefined;
  }
}
