/**
 * From the journal to proposals: what the evidence says should change, for me to accept, edit or reject.
 * Pure: journal lines and the profile in, proposals out. Nothing here writes anything.
 *
 *   a repair ("no, I meant Claude Code")          → an app nickname, or a mishearing when no app is meant
 *   a miss, then a rephrase that worked            → a mishearing when only a word or two changed ("plot code" →
 *     (asked or waited, then within 20 s a          "claude code"), else my own phrase ("make it louder" means
 *     command that ran)                              "volume up")
 *   "I can't … yet"                                → the wishlist, for the surfaces to add
 *   an action I undid or flagged ("that was wrong") → an eval case, so it can't happen again unnoticed
 *
 * Every proposal also says which eval case it becomes: what I said, and what it should do.
 */
import { nameApp, type AppEntry } from "../core/apps.ts";
import type { PressEntry, SignalLine } from "../journal/journal.ts";
import type { Profile } from "../profile/profile.ts";

export interface PersonalCase {
  id: string;
  said: string;
  meant: string;
  expect: Record<string, string>;
  tags: string[];
}

export interface Evidence {
  at: string;
  said: string;
  then?: string;
}

export type Proposal = {
  key: string;
  /** One line for the person reviewing. */
  title: string;
  evidence: Evidence[];
  /** The eval case it becomes (its id is given when it's written). */
  case: Omit<PersonalCase, "id">;
} & (
  | { kind: "mishearing"; heard: string; meant: string; where: "anywhere" | "start" }
  | { kind: "nickname"; app: string; name: string }
  | { kind: "phrase"; say: string; does: string }
  | { kind: "request"; what: string }
  | { kind: "case" }
);

const CHOICE = /^(?:one|two|three|four|1|2|3|4|yes|yeah|yep|no|nope|confirm|cancel|the first one|the second one)$/;
const NOT_YET = /"([a-z ]+)" isn't something I can do yet/;
const NOT_HERE = /^([a-z_.]+) would act outside (.+), which was named$/;
const PAIR_MS = 20_000;

/** Slots that follow from another one: the surface's own id for the app, an item's label. */
const DERIVED = new Set(["app_id", "item_label"]);

/** What a press that worked did, as an eval expectation: the operation and every slot it was decided with. */
export function expectFrom(p: PressEntry): Record<string, string> {
  const o = p.outcome;
  const out: Record<string, string> = o.decision === "act" ? {} : { decision: o.decision };
  if (o.operation) out.operation = o.operation;
  for (const [k, v] of Object.entries(o.slots ?? {})) {
    if (!DERIVED.has(k) && (typeof v === "string" || typeof v === "number")) out[k] = String(v);
  }
  return out;
}

/** "open plot code" vs "open claude code" → plot code / claude code: one to three words swapped, the rest the same. */
export interface Swap {
  heard: string;
  meant: string;
  /** The swap starts the sentence. */
  first: boolean;
  /** The word just before it, for context. */
  before?: string;
}

/** "open" and "opens", "search" and "searching": the same word for this purpose. */
const sameWord = (a: string, b: string) => {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short) && /^(?:s|es|ed|d|ing)$/.test(long.slice(short.length));
};

export function substitution(a: string, b: string): Swap | undefined {
  const x = a.split(" ").filter(Boolean);
  const y = b.split(" ").filter(Boolean);
  let p = 0;
  while (p < x.length && p < y.length && sameWord(x[p]!, y[p]!)) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && sameWord(x[x.length - 1 - s]!, y[y.length - 1 - s]!)) s++;
  const heard = x.slice(p, x.length - s);
  const meant = y.slice(p, y.length - s);
  if (p + s === 0 || heard.length < 1 || heard.length > 3 || meant.length < 1 || meant.length > 3) return undefined;
  return { heard: heard.join(" "), meant: meant.join(" "), first: p === 0, ...(p > 0 ? { before: y[p - 1] } : {}) };
}

/**
 * A swapped name: an app nickname when the right words name an app and the heard ones don't; else a mishearing.
 * A mishearing is fixed anywhere in a sentence, so a single heard word is never fixed on its own: as a sentence's
 * first word it's fixed only there ("some music" → "stop the music"), elsewhere together with the word before it
 * ("next term" → "next track"), so "play some music" stays as said.
 */
function nameFix(sub: Swap, apps: readonly AppEntry[], ev: Evidence, kase: Omit<PersonalCase, "id">): Proposal | undefined {
  const app = nameApp(sub.meant, apps);
  if (app && !nameApp(sub.heard, apps)) {
    return { kind: "nickname", key: `nickname:${app.app.name}:${sub.heard}`, app: app.app.name, name: sub.heard, title: `call ${app.app.name} "${sub.heard}"`, evidence: [ev], case: kase };
  }
  const oneWord = !sub.heard.includes(" ");
  if (oneWord && !sub.first && !sub.before) return undefined;
  const [heard, meant] = oneWord && !sub.first ? [`${sub.before} ${sub.heard}`, `${sub.before} ${sub.meant}`] : [sub.heard, sub.meant];
  const where = oneWord && sub.first ? "start" : "anywhere";
  return { kind: "mishearing", key: `mishearing:${heard}=>${meant}`, heard, meant, where, title: `"${heard}" is a mishearing of "${meant}"${where === "start" ? " (as the first word only)" : ""}`, evidence: [ev], case: kase };
}

/** What a "can't" outcome asked for: the verb with no action ("rotate"), or the operation in the app ("search web in Notion"). */
export function wishIn(reason: string): string | undefined {
  const notYet = NOT_YET.exec(reason)?.[1];
  if (notYet) return notYet;
  const notHere = NOT_HERE.exec(reason);
  return notHere ? `${notHere[1]!.replace(/[_.]/g, " ")} in ${notHere[2]}` : undefined;
}

/** Implicit rephrases must happen this often before they become a phrase: once can be just moving on. */
const PHRASE_MIN = 2;

const day = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

export function propose(lines: ReadonlyArray<PressEntry | SignalLine>, prof: Profile, apps: readonly AppEntry[]): Proposal[] {
  const presses = lines.filter((l): l is PressEntry => l.type === "press" && l.speech);
  const signals = lines.filter((l): l is SignalLine => l.type === "signal");
  const byId = new Map(presses.map((p) => [p.id, p]));
  const out = new Map<string, Proposal>();
  /** Phrases I stated myself ("I mean …"), which count from the first time. */
  const stated = new Set<string>();
  const add = (p: Proposal | undefined) => {
    if (!p) return;
    const had = out.get(p.key);
    if (had) had.evidence.push(...p.evidence);
    else out.set(p.key, p);
  };
  const phrase = (say: string, does: string, ev: Evidence, kase: Omit<PersonalCase, "id">): Proposal => ({ kind: "phrase", key: `phrase:${say}=>${does}`, say, does, title: `when I say "${say}", I mean "${does}"`, evidence: [ev], case: kase });

  presses.forEach((x, i) => {
    const next = presses[i + 1];
    const ev = next ? { at: day(x.t), said: x.heard, then: next.heard } : { at: day(x.t), said: x.heard };
    // 1. a repair of the previous command: the swapped words are a name I use or a mishearing; "I mean <a whole
    //    command>" says what my sentence meant
    if (next?.repair && next.ran) {
      const kase = { said: x.heard, meant: next.repair.to, expect: expectFrom(next), tags: ["learned", "repair"] };
      if (next.repair.kind === "name" || next.repair.kind === "swap") {
        const sub = substitution(next.repair.from, next.repair.to);
        if (sub) add(nameFix(sub, apps, ev, kase));
      } else if (next.repair.kind === "again" && next.repair.from !== next.repair.to && !next.repair.to.startsWith(`${next.repair.from} `)) {
        // ("open a new tab" → "open a new tab in terminal" names the app it was for: context, not a phrase)
        const p = phrase(next.repair.from, next.repair.to, ev, kase);
        stated.add(p.key);
        add(p);
      }
      return;
    }
    // 2. a miss, then a rephrase that worked
    const missed = x.outcome.decision === "ask" || x.outcome.decision === "wait" || Boolean(x.error);
    if (missed && next && next.ran && next.t - x.t <= PAIR_MS && !CHOICE.test(next.text) && next.text !== x.text) {
      const kase = { said: x.heard, meant: next.text, expect: expectFrom(next), tags: ["learned"] };
      const sub = substitution(x.text, next.text);
      if (sub) add(nameFix(sub, apps, ev, kase));
      else if (x.outcome.decision === "ask" && x.text.split(" ").length <= 8) add(phrase(x.text, next.text, ev, kase));
    }
    // 3. something nothing can do yet: a verb with no action, or an app with no skill for it
    const what = wishIn(x.outcome.reason);
    if (what) {
      add({ kind: "request", key: `request:${what}`, what, title: `wish: "${what}" (nothing can do it yet)`, evidence: [{ at: day(x.t), said: x.heard }], case: { said: x.heard, meant: `${what}: not possible yet, so ask`, expect: { decision: "ask" }, tags: ["learned", "wish"] } });
    }
  });
  // a rephrase seen once can be just moving on to something else
  for (const [k, p] of out) if (p.kind === "phrase" && !stated.has(k) && p.evidence.length < PHRASE_MIN) out.delete(k);

  // 4. actions I undid or flagged: they must not happen again unnoticed
  for (const s of signals.filter((s) => s.signal === "undone" || s.signal === "flagged")) {
    const x = byId.get(s.ref);
    if (!x?.ran) continue;
    add({ kind: "case", key: `case:${x.text}`, title: `"${x.text}" did ${x.plan ?? x.outcome.operation}, and you ${s.signal === "undone" ? "undid it" : "said it was wrong"}`, evidence: [{ at: day(x.t), said: x.heard }], case: { said: x.heard, meant: "not what it did: ask instead (edit if you know what it should do)", expect: { decision: "ask" }, tags: ["learned", s.signal] } });
  }

  // what's already in the profile, or already decided, isn't proposed again
  const known = (p: Proposal) => {
    if (prof.decided[p.key]) return true;
    if (p.kind === "mishearing") return (prof.aliases[p.where === "start" ? "starts" : "phrases"][p.meant] ?? []).includes(p.heard);
    if (p.kind === "nickname") return (prof.nicknames[p.app] ?? []).includes(p.name);
    if (p.kind === "phrase") return prof.phrases.some((ph) => ph.say === p.say);
    if (p.kind === "request") return prof.wishlist.some((w) => w.what === p.what);
    return false;
  };
  return [...out.values()].filter((p) => !known(p)).sort((a, b) => b.evidence.length - a.evidence.length);
}

/** The profile with an accepted proposal in it. Pure. */
export function accept(prof: Profile, p: Proposal): Profile {
  const next: Profile = structuredClone(prof);
  next.decided[p.key] = "accepted";
  if (p.kind === "mishearing") {
    const part = p.where === "start" ? next.aliases.starts : next.aliases.phrases;
    part[p.meant] = [...(part[p.meant] ?? []), p.heard];
  }
  if (p.kind === "nickname") next.nicknames[p.app] = [...(next.nicknames[p.app] ?? []), p.name];
  if (p.kind === "phrase") next.phrases.push({ say: p.say, do: p.does });
  if (p.kind === "request") {
    const had = next.wishlist.find((w) => w.what === p.what);
    if (had) had.times += p.evidence.length;
    else next.wishlist.push({ what: p.what, times: p.evidence.length });
  }
  return next;
}

/** The profile remembering a rejection. Pure. */
export function reject(prof: Profile, p: Proposal): Profile {
  const next: Profile = structuredClone(prof);
  next.decided[p.key] = "rejected";
  return next;
}
