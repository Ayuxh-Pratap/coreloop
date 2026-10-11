/**
 * No-model mode: the engine still works when no decision model is running. What code decides on its own (app
 * verbs, templates, the grammar, items by position, words or sound) is done exactly as with the model; everything
 * else gets a question with what can be said here, never an error and never a guess.
 *
 *   CodeOnlyDecider   answers nothing, so the policy asks
 *   FallbackDecider   the model while it answers; code only while it's unreachable or too slow, back to the model
 *                     as soon as it answers again
 */
import { SystemOneError, type Decider, type Decision, type SystemOneRequest } from "./systemone.ts";

/** The `model` of a decision made with no model. */
export const CODE_ONLY = "code only";

/** No model: it answers nothing, so code decides what it can and everything else becomes a question. */
export class CodeOnlyDecider implements Decider {
  /** Answers nothing. */
  async decide(): Promise<Decision> {
    return { answers: {}, model: CODE_ONLY, inputTokens: 0, latencyMs: 0 };
  }
}

/**
 * The model while it answers; code only while it's unreachable or too slow, and the model again as soon as it answers.
 * Only `timeout` and `unreachable` fall back: a model that answers wrongly is an error to see, not to hide.
 *
 * @example
 * const client = new FallbackDecider(new SystemOneClient({ baseUrl: "http://127.0.0.1:8001", timeoutMs: 3000 }), {
 *   onChange: (usingModel, why) => console.log(usingModel ? "model on" : `code only (${why})`),
 * });
 */
export class FallbackDecider implements Decider {
  private readonly primary: Decider;
  private readonly fallback: Decider;
  private readonly onChange?: (usingModel: boolean, why?: string) => void;
  private usingModel = true;

  constructor(primary: Decider, opts: { fallback?: Decider; onChange?: (usingModel: boolean, why?: string) => void } = {}) {
    this.primary = primary;
    this.fallback = opts.fallback ?? new CodeOnlyDecider();
    this.onChange = opts.onChange;
  }

  /** Whether the last request was answered by the model. */
  get model(): boolean {
    return this.usingModel;
  }

  /** Asks the model, or code only while the model doesn't answer. */
  async decide(req: SystemOneRequest, signal?: AbortSignal): Promise<Decision> {
    try {
      const d = await this.primary.decide(req, signal);
      this.switch(true);
      return d;
    } catch (err) {
      // only a model that isn't there (or doesn't answer in time) falls back; a bad answer or a cancel is an error
      if (signal?.aborted || !(err instanceof SystemOneError) || (err.code !== "unreachable" && err.code !== "timeout")) throw err;
      this.switch(false, `${err.code}: ${err.message}`);
      return this.fallback.decide(req, signal);
    }
  }

  private switch(usingModel: boolean, why?: string): void {
    if (usingModel === this.usingModel) return;
    this.usingModel = usingModel;
    this.onChange?.(usingModel, why);
  }
}
