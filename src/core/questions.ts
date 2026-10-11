/**
 * Builds the decision request for one utterance.
 *
 * Rules:
 *  - the state is the user's words only; window/page text never goes in (small models echo it back)
 *  - gates are two-way choices, not yes/no questions (yes/no heads were unreliable on small models)
 *  - every choice includes a way to say "none of these"
 */
import type { Criteria, Questions, SystemOneRequest } from "../backends/systemone.ts";
import { COMMON_OPERATIONS, type Operation } from "./operations.ts";
import { optionText, type Item } from "./items.ts";

export function operationCriteria(ops: readonly Operation[]): Criteria {
  return Object.fromEntries(ops.map((o) => [o.id, o.what]));
}

/** How `buildRequest()` builds the model's request. */
export interface RequestOptions {
  /** false packs all questions behind one copy of the state. Measured worse; kept for re-checks. */
  independent?: boolean;
  /**
   * Also ask "is this a command?". Off by default: in the evals it threw away real commands (87.7% right without it,
   * 67.7% with it). The operation question's `none` option already catches chit-chat.
   */
  isCommand?: boolean;
  /**
   * The operation question's options: the surface's common operations, the actions offered everywhere and the
   * target's own actions (`SkillSet.modelOptions`). Default: every common operation.
   */
  operations?: readonly Operation[];
  /**
   * Items to choose from, at most 16, in screen order: they become the `item` question's options. Labels are
   * options only, never the state.
   */
  items?: readonly Item[];
}

/**
 * The request code writes for the model: the user's words as the state, and the questions with the options code
 * wrote. Window, page and app text never go in the state.
 */
export function buildRequest(transcript: string, opts: RequestOptions = {}): SystemOneRequest {
  const questions: Questions = {
    operation: {
      type: "choice",
      instructions: "What does the user want the computer to do? Judge only from `transcript`.",
      criteria: operationCriteria(opts.operations ?? COMMON_OPERATIONS),
    },
  };
  if (opts.isCommand ?? false) {
    questions.is_command = {
      type: "choice",
      instructions: "Is `transcript` an instruction for the computer?",
      criteria: {
        command: "an instruction for the computer to do something",
        not_command: "chit-chat, talking to someone else, or thinking aloud",
      },
    };
  }
  questions.complete = {
    type: "choice",
    instructions: "Has the user finished saying the instruction in `transcript`?",
    criteria: {
      finished: "a complete instruction that can be carried out",
      unfinished: "it stops before the important part (open the, paste into, go to)",
    },
  };
  if (opts.items?.length) {
    questions.item = {
      type: "choice",
      instructions: "Which item on the screen does the user in `transcript` mean (to click, open, type into or choose)? Options are in screen order, top first.",
      criteria: { ...Object.fromEntries(opts.items.map((i) => [i.id, optionText(i)])), none: "nothing on the screen is meant" },
    };
  }
  return { state: { transcript }, independent: opts.independent, questions };
}
