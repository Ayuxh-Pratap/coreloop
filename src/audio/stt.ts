/**
 * Speech to text, fully local and on the CPU: Silero VAD finds the speech, Parakeet TDT 0.6B v2 int8
 * transcribes it, both through sherpa-onnx. The GPU stays free for the decision model.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
// sherpa-onnx-node is a CommonJS native addon without type declarations.
const sherpa = require("sherpa-onnx-node") as SherpaModule;

interface SherpaModule {
  OfflineRecognizer: new (config: unknown) => {
    createStream(): { acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void };
    decode(stream: unknown): void;
    getResult(stream: unknown): { text: string };
  };
  Vad: new (config: unknown, bufferSeconds: number) => {
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    front(): { samples: Float32Array; start: number };
    pop(): void;
    flush(): void;
    reset(): void;
  };
  readWave(path: string): { samples: Float32Array; sampleRate: number };
}

export const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512;

export interface SttOptions {
  /** Folder with encoder/decoder/joiner .int8.onnx and tokens.txt. */
  modelDir: string;
  /** silero_vad.onnx */
  vadModel: string;
  threads: number;
}

export const DEFAULT_STT: SttOptions = {
  modelDir: join(".models", "parakeet", "parakeet-tdt-0.6b-v2-int8"),
  vadModel: join(".models", "parakeet", "silero_vad.onnx"),
  threads: Number(process.env.COLOOP_STT_THREADS ?? 4),
};

export interface Transcript {
  text: string;
  /** False when VAD found no speech; nothing was transcribed. */
  speech: boolean;
  /** Length of the recording. */
  audioSec: number;
  /** Speech found by VAD, seconds. */
  speechSec: number;
  vadMs: number;
  sttMs: number;
}

export class SpeechToText {
  private readonly recognizer: InstanceType<SherpaModule["OfflineRecognizer"]>;
  private readonly vadConfig: unknown;
  readonly loadMs: number;

  constructor(opts: SttOptions = DEFAULT_STT) {
    const t = performance.now();
    this.recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: join(opts.modelDir, "encoder.int8.onnx"),
          decoder: join(opts.modelDir, "decoder.int8.onnx"),
          joiner: join(opts.modelDir, "joiner.int8.onnx"),
        },
        tokens: join(opts.modelDir, "tokens.txt"),
        numThreads: opts.threads,
        provider: "cpu",
        modelType: "nemo_transducer",
        debug: 0,
      },
    });
    this.vadConfig = {
      sileroVad: { model: opts.vadModel, threshold: 0.5, minSpeechDuration: 0.2, minSilenceDuration: 0.4, windowSize: VAD_WINDOW },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      provider: "cpu",
      debug: false,
    };
    this.loadMs = performance.now() - t;
  }

  /** Speech regions in a recording, as [startSample, endSample) pairs. */
  speechRegions(samples: Float32Array): Array<[number, number]> {
    const vad = new sherpa.Vad(this.vadConfig, Math.max(5, samples.length / SAMPLE_RATE + 1));
    for (let i = 0; i + VAD_WINDOW <= samples.length; i += VAD_WINDOW) vad.acceptWaveform(samples.subarray(i, i + VAD_WINDOW));
    vad.flush();
    const regions: Array<[number, number]> = [];
    while (!vad.isEmpty()) {
      const seg = vad.front();
      regions.push([seg.start, seg.start + seg.samples.length]);
      vad.pop();
    }
    return regions;
  }

  /**
   * Transcribes one push-to-talk recording. VAD decides whether there is speech at all (an empty press returns
   * speech:false) and trims silence around it, with a little margin so word edges survive.
   */
  transcribe(samples: Float32Array): Transcript {
    const audioSec = samples.length / SAMPLE_RATE;
    const t0 = performance.now();
    const regions = this.speechRegions(samples);
    const vadMs = performance.now() - t0;
    if (regions.length === 0) return { text: "", speech: false, audioSec, speechSec: 0, vadMs, sttMs: 0 };

    const margin = Math.round(0.2 * SAMPLE_RATE);
    const from = Math.max(0, regions[0]![0] - margin);
    const to = Math.min(samples.length, regions.at(-1)![1] + margin);
    const speechSec = regions.reduce((s, [a, b]) => s + (b - a), 0) / SAMPLE_RATE;

    const t1 = performance.now();
    const stream = this.recognizer.createStream();
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: samples.subarray(from, to) });
    this.recognizer.decode(stream);
    const text = this.recognizer.getResult(stream).text.trim();
    return { text, speech: text.length > 0, audioSec, speechSec, vadMs, sttMs: performance.now() - t1 };
  }
}

/** Reads a WAV file as 16 kHz mono float samples (throws on any other rate). */
export function readWav(path: string): Float32Array {
  const w = sherpa.readWave(path);
  if (w.sampleRate !== SAMPLE_RATE) throw new Error(`${path}: ${w.sampleRate} Hz, expected ${SAMPLE_RATE}`);
  return w.samples;
}
