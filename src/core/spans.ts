/**
 * Text the user wants typed, pasted or searched is always a SPAN of their own words:
 * code proposes candidate substrings from the sentence shape, and when there is more than one the model only
 * picks among them. Nothing here can produce a word the user didn't say.
 */

export type SpanKind = "paste" | "type" | "search";

export interface SpanCandidate {
  kind: SpanKind;
  text: string;
}

const PATTERNS: ReadonlyArray<[SpanKind, RegExp]> = [
  ["paste", /^paste(?: in| out)? (.+?)(?: (?:here|in here|into (?:this|the) (?:window|field|box|chat)))?$/],
  ["type", /^(?:type|write|enter)(?: out| in)? (.+?)(?: (?:here|in here|(?:into|in) (?:the|this) [\w ]*(?:field|box|window|chat|bar)))?$/],
  ["search", /^(?:search(?: the web| online| google)? for|search|google|look up|look for|find(?: me)?) (.+?)(?: (?:on google|online|on the web))?$/],
];

/** Every candidate span the sentence shapes allow, most specific first, de-duplicated. */
export function spanCandidates(text: string): SpanCandidate[] {
  const out: SpanCandidate[] = [];
  for (const [kind, re] of PATTERNS) {
    const m = re.exec(text);
    const span = m?.[1]?.trim();
    if (span && !out.some((c) => c.kind === kind && c.text === span)) out.push({ kind, text: span });
  }
  return out;
}

export function spanFor(kind: SpanKind, text: string): string | undefined {
  return spanCandidates(text).find((c) => c.kind === kind)?.text;
}

/** Function words: a phrase ending on one is always unfinished ("open the", "paste into", "go to"). */
const DANGLING_WORDS = new Set(["the", "a", "an", "to", "into", "in", "on", "for", "and", "with", "at", "of", "my"]);
/**
 * Command verbs: unfinished only when nothing came before them but a lead-in ("open", "and then open",
 * "please paste"). "get vs code open" ends on a verb and is complete.
 */
const DANGLING_VERBS = new Set(["open", "go", "switch", "paste", "type", "write", "search", "press", "hit", "close", "launch", "start", "put", "send"]);
const LEAD_IN = new Set(["and", "then", "please", "now", "also", "to"]);

export function endsDangling(text: string): boolean {
  const words = text.trim().split(" ");
  const last = words.at(-1) ?? "";
  if (DANGLING_WORDS.has(last)) return true;
  if (!DANGLING_VERBS.has(last)) return false;
  return words.slice(0, -1).every((w) => LEAD_IN.has(w));
}
