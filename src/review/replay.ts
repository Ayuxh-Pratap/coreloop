/**
 * Replay: before anything is proposed, the sentence behind it goes through the core as it is today, scored
 * exactly like its eval case would be. A miss the core has since learned to handle isn't proposed again; the
 * journal remembers every old mistake, the review only brings up the ones that still happen.
 *
 *   mishearing, nickname, phrase   dropped when today's core already does what was meant
 *   request                        dropped when today's core no longer gives the same "can't" (something can do it
 *                                  now, or the "can't" came from a bug since fixed)
 *   case (an undone action)        always kept: a test that it can't happen again
 */
import type { Decider } from "../backends/systemone.ts";
import { understand } from "../core/pipeline.ts";
import type { SlotContext } from "../core/slots.ts";
import { scorePipeline } from "../eval/score.ts";
import { wishIn, type Proposal } from "./proposals.ts";

export async function stillMissing(proposals: readonly Proposal[], client: Decider, ctx: SlotContext): Promise<{ keep: Proposal[]; handled: Proposal[] }> {
  const keep: Proposal[] = [];
  const handled: Proposal[] = [];
  for (const p of proposals) {
    if (p.kind === "case") {
      keep.push(p);
      continue;
    }
    const u = await understand(client, p.case.said, { ctx });
    // a wish still stands only while today's core still says the same "can't"
    const done = p.kind === "request" ? wishIn(u.outcome.reason) !== p.what : scorePipeline({ id: p.key, said: p.case.said, expect: p.case.expect }, u.outcome).pass;
    (done ? handled : keep).push(p);
  }
  return { keep, handled };
}
