/*
 * A person's profile: what makes the engine theirs, as data, the same for every surface. The engine never
 * reads it from anywhere: a host hands it in with `useProfile()`, from files (src/host/profile-files.ts), a
 * browser's storage, or a website's settings. Until then the engine runs with an empty profile.
 *
 *   aliases    speech-to-text slips: "plot code" → claude code (anywhere), "nose" → close (first word only)
 *   phrases    my own sentences: when I say X, it means the command Y. Y goes through every rule, confirms included,
 *              exactly as if I'd said it
 *   nicknames  names for apps: "my notes" → Obsidian. Only ever an app's name, never rewrites my words
 *   dictationEnds  words I say after dictated text that aren't part of it ("npm run dev command")
 *   sites      names for websites: "gmail" → mail.google.com. Code opens exactly that address; the model never writes one
 *   off        actions turned off: never decided, never offered. Turning off is the only direction; confirm, cancel
 *              and the other conversation operations can't be turned off
 *   wishlist   things I asked for that nothing can do yet, for the surfaces to add (changes no behaviour)
 *   decided    what the review already decided, so a rejected proposal isn't proposed again
 *
 * Safety rules (confirms, no Enter without "confirm", the model only picks) are not data and not in scope.
 */

/** A sentence of a person's own that means another command. */
export interface Phrase {
  /** What they say, as the engine sees it after normalising ("make it louder"). */
  say: string;
  /** The command it means ("volume up"). */
  do: string;
}

/**
 * One person's words, as data: what their speech-to-text gets wrong, their own sentences, what they call things. It can
 * only rewrite text and take actions away; it can't change any safety rule.
 */
export interface Profile {
  /** Mishearings, meant → heard: `phrases` are fixed anywhere, `starts` only as the first word. */
  aliases: { phrases: Record<string, string[]>; starts: Record<string, string[]> };
  /** Their own sentences, each meaning another command, which then passes every rule. */
  phrases: Phrase[];
  /** A place's name → their names for it. */
  nicknames: Record<string, string[]>;
  /** Words they add after dictated text ("command"), dropped from its end when at least two words are left. */
  dictationEnds: string[];
  /** Spoken site name (lowercase) → host[/path] without a scheme. */
  sites: Record<string, string>;
  /** Actions turned off: never decided, never offered. `confirm`, `cancel`, `none` and `choose` can't be. */
  off: string[];
  /** What they asked for that can't be done yet. Changes no behaviour. */
  wishlist: { what: string; times: number }[];
  /** What the review already decided, so a rejected proposal isn't proposed again. Changes no behaviour. */
  decided: Record<string, "accepted" | "rejected">;
}

/** Operations the conversation needs; turning them off would take away "confirm" and "cancel". */
const NEVER_OFF = new Set(["confirm", "cancel", "none", "choose"]);

/** A profile that isn't valid. Its message names the first problem. */
export class ProfileError extends Error {}

/** No mishearings, phrases, nicknames, dictation ends, sites or actions turned off: the engine as it ships. */
export const EMPTY_PROFILE: Profile = Object.freeze({
  aliases: { phrases: {}, starts: {} },
  phrases: [],
  nicknames: {},
  dictationEnds: [],
  sites: {},
  off: [],
  wishlist: [],
  decided: {},
}) as Profile;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** Throws ProfileError naming the first problem. */
export function checkProfile(p: Profile): void {
  if (!isObj(p) || !isObj(p.aliases) || !isObj(p.aliases.phrases) || !isObj(p.aliases.starts)) throw new ProfileError("aliases must have phrases and starts");
  for (const [k, v] of [...Object.entries(p.aliases.phrases), ...Object.entries(p.aliases.starts)]) {
    if (!isStr(k) || !strList(v)) throw new ProfileError(`aliases: "${k}" must map to a list of heard phrases`);
  }
  if (!Array.isArray(p.phrases)) throw new ProfileError("phrases must be a list");
  const says = new Set<string>();
  for (const ph of p.phrases) {
    if (!isObj(ph) || !isStr(ph.say) || !isStr(ph.do)) throw new ProfileError("each phrase needs 'say' and 'do'");
    if (ph.say === ph.do) throw new ProfileError(`phrase "${ph.say}" means itself`);
    if (says.has(ph.say)) throw new ProfileError(`phrase "${ph.say}" twice`);
    says.add(ph.say);
  }
  if (!isObj(p.nicknames)) throw new ProfileError("nicknames must map app names to lists");
  for (const [app, names] of Object.entries(p.nicknames)) if (!strList(names)) throw new ProfileError(`nicknames for "${app}" must be a list`);
  if (!strList(p.dictationEnds) || p.dictationEnds.some((e) => e !== e.toLowerCase().trim())) throw new ProfileError("dictation ends must be a list of lowercase words");
  if (!isObj(p.sites)) throw new ProfileError("sites must map site names to addresses");
  for (const [name, url] of Object.entries(p.sites)) {
    if (!isStr(name) || name !== name.toLowerCase()) throw new ProfileError(`site name "${name}" must be lowercase words`);
    if (typeof url !== "string" || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{2,5})?(?:\/\S*)?$/i.test(url)) {
      throw new ProfileError(`site "${name}" must be a host[/path] without a scheme`);
    }
  }
  if (!strList(p.off)) throw new ProfileError("off must be a list of action ids");
  const unsafe = p.off.filter((o) => NEVER_OFF.has(o));
  if (unsafe.length) throw new ProfileError(`can't turn off ${unsafe.join(", ")}: the conversation needs them`);
}

let current: Profile = EMPTY_PROFILE;

/**
 * Hands the engine a person's profile, after checking it. Everything decided from then on uses it. The engine reads
 * no files: keeping the profile is the host's job.
 *
 * @example
 * useProfile({ ...EMPTY_PROFILE, phrases: [{ say: "focus time", do: "mute" }] });
 * @throws {ProfileError} naming the first problem.
 */
export function useProfile(p: Profile): void {
  checkProfile(p);
  current = p;
}

/** The profile the engine runs with now. */
export function currentProfile(): Profile {
  return current;
}
