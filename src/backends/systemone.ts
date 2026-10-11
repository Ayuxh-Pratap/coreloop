/**
 * Typed client for the System One wire format (POST /v1/systemone), which decider.serve speaks natively.
 *
 * The model never generates text: every question is answered with probabilities over options the caller
 * built. This client refuses any answer that doesn't fit the question it was asked (an option that was not
 * offered, probabilities that don't cover the offered set or don't sum to ~1), so nothing downstream can act
 * on a malformed decision.
 */

/** Option name → short description shown to the model (null = the name alone). */
export type Criteria = Record<string, string | null>;

export type Question =
  | { type: "choice"; instructions: string; criteria: Criteria }
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "score"; instructions: string; criteria: string[] };

export type Questions = Record<string, Question>;

/** A request to the model: the state, and the questions to answer about it. */
export interface SystemOneRequest {
  /** What the model reads. Keep it to the user's words: small models echo page or window text back. */
  state: string | Record<string, unknown>;
  /** The questions, each with the options to pick from. */
  questions: Questions;
  /** false packs all questions behind one copy of the state (fewer tokens, answers may influence each other). */
  independent?: boolean;
}

/** The answer to a choice question. */
export interface ChoiceAnswer {
  type: "choice";
  /** The option picked: always the most likely one. */
  choice: string;
  /** How far the top probability is above chance, from 0 to 1: (p_max − 1/K) / (1 − 1/K) for K options. */
  confidence: number;
  /** Each option's probability. */
  probabilities: Record<string, number>;
  /** Options sorted by probability, highest first. */
  ranked: { option: string; p: number }[];
}
export interface NoulAnswer {
  type: "noul";
  /** P(true). */
  noul: number;
}
export interface ScoreAnswer {
  type: "score";
  /** Expected level, 0 … levels−1. */
  score: number;
  probabilities: number[];
}
/** An answer to one question. The engine asks choice questions only. */
export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

/** The model's answers to one request. */
export interface Decision {
  /** One answer per question. */
  answers: Record<string, Answer>;
  /** Which model answered (`CODE_ONLY` when none did). */
  model: string;
  /** How many tokens the request took. */
  inputTokens: number;
  /** Wall-clock time of the HTTP round trip. */
  latencyMs: number;
}

/** Why a request to the model failed: `timeout`, `unreachable`, `http`, or `invalid_answer` (it picked something it wasn't offered). */
export class SystemOneError extends Error {
  readonly code: "unreachable" | "timeout" | "http" | "invalid_answer";
  constructor(code: SystemOneError["code"], message: string) {
    super(message);
    this.name = "SystemOneError";
    this.code = code;
  }
}

export function choiceConfidence(probs: number[]): number {
  const k = probs.length;
  if (k <= 1) return 1;
  const pMax = Math.max(...probs);
  return Math.min(1, Math.max(0, (pMax - 1 / k) / (1 - 1 / k)));
}

const SUM_TOLERANCE = 0.02;

/** Checks a raw answer against the question that was asked and normalises it. Throws SystemOneError. */
export function validateAnswer(id: string, q: Question, raw: unknown): Answer {
  const bad = (why: string) => new SystemOneError("invalid_answer", `answer "${id}": ${why}`);
  if (typeof raw !== "object" || raw === null) throw bad("missing");
  const a = raw as Record<string, unknown>;

  if (q.type === "choice") {
    const offered = Object.keys(q.criteria);
    const probs = a.probabilities as Record<string, unknown> | undefined;
    if (typeof a.choice !== "string" || !offered.includes(a.choice)) throw bad(`choice ${JSON.stringify(a.choice)} was not offered`);
    if (!probs || typeof probs !== "object") throw bad("no probabilities");
    const keys = Object.keys(probs);
    if (keys.length !== offered.length || !offered.every((o) => keys.includes(o))) throw bad("probabilities don't cover the offered options");
    const values = offered.map((o) => probs[o]);
    if (!values.every((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0)) throw bad("non-numeric probability");
    const sum = values.reduce((s, v) => s + v, 0);
    if (Math.abs(sum - 1) > SUM_TOLERANCE) throw bad(`probabilities sum to ${sum.toFixed(3)}`);
    const ranked = offered.map((option, i) => ({ option, p: values[i]! / sum })).sort((x, y) => y.p - x.p);
    if (ranked[0]!.option !== a.choice && ranked[0]!.p - (probs[a.choice] as number) / sum > 1e-6) throw bad("choice is not the most likely option");
    return {
      type: "choice",
      choice: a.choice,
      confidence: choiceConfidence(ranked.map((r) => r.p)),
      probabilities: Object.fromEntries(ranked.map((r) => [r.option, r.p])),
      ranked,
    };
  }

  if (q.type === "noul") {
    if (typeof a.noul !== "number" || !(a.noul >= 0 && a.noul <= 1)) throw bad("noul must be a probability");
    return { type: "noul", noul: a.noul };
  }

  const levels = q.criteria.length;
  if (typeof a.score !== "number" || !(a.score >= 0 && a.score <= levels - 1)) throw bad(`score must be within 0..${levels - 1}`);
  const p = a.probabilities as Record<string, unknown> | undefined;
  const probabilities = Array.from({ length: levels }, (_, i) => (typeof p?.[String(i)] === "number" ? (p[String(i)] as number) : 0));
  return { type: "score", score: a.score, probabilities };
}

/** Where the model server is, and how long to wait for it. */
export interface ClientOptions {
  /** Such as `http://127.0.0.1:8001`. */
  baseUrl: string;
  /** How long to wait for an answer before failing with `timeout`. */
  timeoutMs: number;
}

/**
 * Anything that answers a request: `SystemOneClient` over HTTP, `CodeOnlyDecider` with no model, recorded answers in
 * a browser, or answers by hand in a test. The engine depends on this, never on a transport.
 */
export interface Decider {
  decide(req: SystemOneRequest, signal?: AbortSignal): Promise<Decision>;
}

/**
 * decider-0.8b, or any model served with the same `/v1/systemone` API, over HTTP on the user's machine. Every answer
 * is validated: one that picks something it wasn't offered is refused.
 *
 * @example
 * const model = new SystemOneClient({ baseUrl: "http://127.0.0.1:8001", timeoutMs: 3000 });
 * const actor = new Actor({ client: new FallbackDecider(model), surface });
 */
export class SystemOneClient implements Decider {
  readonly baseUrl: string;
  readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs;
  }

  /** Whether the server answers its health check, and which model it serves. */
  async health(signal?: AbortSignal): Promise<{ ok: boolean; model?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: signal ?? AbortSignal.timeout(2000) });
      if (!res.ok) return { ok: false };
      const body = (await res.json()) as { ok?: boolean; model?: string };
      return { ok: body.ok === true, model: body.model };
    } catch {
      return { ok: false };
    }
  }

  /** Sends the request and validates every answer. Fails with a `SystemOneError`. */
  async decide(req: SystemOneRequest, signal?: AbortSignal): Promise<Decision> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal: combined,
      });
    } catch (err) {
      if (timeout.aborted) throw new SystemOneError("timeout", `no answer within ${this.timeoutMs} ms`);
      if (signal?.aborted) throw err; // caller cancelled: rethrow the AbortError untouched
      throw new SystemOneError("unreachable", `cannot reach ${this.baseUrl} (${(err as Error).message}). Is it running? npm run models:start`);
    }
    if (!res.ok) throw new SystemOneError("http", `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { model?: string; answers?: Record<string, unknown>; usage?: { input_tokens?: number } };
    const latencyMs = performance.now() - t0;

    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(req.questions)) answers[id] = validateAnswer(id, q, body.answers?.[id]);
    return { answers, model: body.model ?? "unknown", inputTokens: body.usage?.input_tokens ?? 0, latencyMs };
  }
}
