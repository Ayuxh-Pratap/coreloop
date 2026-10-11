/**
 * The profile as files (host): profile/*.json on disk, loaded into the engine with `useProfile()` and written
 * back after a review. The engine itself never touches files (src/profile/profile.ts).
 *
 *   aliases.json  phrases.json  apps.json (nicknames)  dictation.json (ends)  sites.json  actions.json (off)  wishlist.json  review.json (decided)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProfile, ProfileError, useProfile, type Phrase, type Profile } from "../profile/profile.ts";

/** Where the profile lives: COLOOP_PROFILE_DIR, else the repo's profile/ folder. Read when the profile loads. */
export const profileDir = () => process.env.COLOOP_PROFILE_DIR ?? fileURLToPath(new URL("../../profile", import.meta.url));

/**
 * The profile the evals and tests run with (eval/profile/, committed): a fixture, so results are the same on every
 * machine. My own profile (profile/) is gitignored and never published.
 */
export const FIXTURE_PROFILE = fileURLToPath(new URL("../../eval/profile", import.meta.url));

/** For the evals: the fixture, unless a profile is named (COLOOP_PROFILE_DIR, as the learning loop's gate does). */
export const evalProfileDir = () => process.env.COLOOP_PROFILE_DIR ?? FIXTURE_PROFILE;

const FILES = {
  aliases: "aliases.json",
  phrases: "phrases.json",
  apps: "apps.json",
  dictation: "dictation.json",
  sites: "sites.json",
  actions: "actions.json",
  wishlist: "wishlist.json",
  review: "review.json",
} as const;

const NOTES: Record<keyof typeof FILES, string> = {
  aliases:
    "How speech-to-text mishears me → what I meant. Whole words only. 'phrases' are fixed anywhere in a sentence; 'starts' only as its first word. Every entry here came from a real mishearing (journal) or an approved learning-loop proposal (M7). App names that merely sound alike ('cloud' → Claude) don't need an entry: names are also matched by sound, inside name slots only.",
  phrases: "My own sentences: when I say 'say', it means the command 'do', which then goes through every rule (confirms included). From npm run review or my own edits.",
  apps: "Nicknames I use for apps (app name → what I call it). Only ever matched as an app's name; never rewrites dictated words.",
  dictation: "Words I say after dictated text that aren't part of it ('type npm run dev command' types 'npm run dev'). Dropped only from the very end, and only when at least two words are left.",
  sites: "Websites I name without a domain (what I say → host[/path], no https://). Code opens exactly this address; the model never writes a URL.",
  actions: "Actions and common operations turned off: never decided, never offered. confirm/cancel/none/choose can't be turned off.",
  wishlist: "Things I asked for that nothing can do yet (from the journal), for the surfaces to add. Changes no behaviour.",
  review: "What npm run review already decided, so a rejected proposal isn't offered again.",
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function read(dir: string, file: string): Record<string, unknown> {
  const p = join(dir, file);
  if (!existsSync(p)) return {};
  const data = JSON.parse(readFileSync(p, "utf8")) as unknown;
  if (!isObj(data)) throw new ProfileError(`${p}: expected an object`);
  return data;
}

/** The profile in `dir`, checked. Missing files are empty. Throws ProfileError naming the problem. */
export function loadProfile(dir = profileDir()): Profile {
  const a = read(dir, FILES.aliases);
  const p: Profile = {
    aliases: { phrases: (a.phrases ?? {}) as Profile["aliases"]["phrases"], starts: (a.starts ?? {}) as Profile["aliases"]["starts"] },
    phrases: (read(dir, FILES.phrases).phrases ?? []) as Phrase[],
    nicknames: (read(dir, FILES.apps).nicknames ?? {}) as Profile["nicknames"],
    dictationEnds: (read(dir, FILES.dictation).ends ?? []) as string[],
    sites: (read(dir, FILES.sites).sites ?? {}) as Profile["sites"],
    off: (read(dir, FILES.actions).off ?? []) as string[],
    wishlist: (read(dir, FILES.wishlist).requests ?? []) as Profile["wishlist"],
    decided: (read(dir, FILES.review).decided ?? {}) as Profile["decided"],
  };
  checkProfile(p);
  return p;
}

/** Loads the profile from disk and hands it to the engine. Every command that decides calls this first. */
export function useProfileFiles(dir = profileDir()): Profile {
  const p = loadProfile(dir);
  useProfile(p);
  return p;
}

/** JSON as a person would write it: lists of words on one line. */
function pretty(v: unknown): string {
  return JSON.stringify(v, null, 2).replace(/\[\n\s+((?:"(?:[^"\\]|\\.)*",?\s*)+)\n\s*\]/g, (_m, inner: string) => `[${inner.split(/,\s*\n\s*/).join(", ").trim()}]`);
}

/** Writes the profile back, one file per part, each with its note. */
export function saveProfile(p: Profile, dir = profileDir()): void {
  checkProfile(p);
  const write = (key: keyof typeof FILES, body: Record<string, unknown>) =>
    writeFileSync(join(dir, FILES[key]), pretty({ note: NOTES[key], ...body }) + "\n");
  write("aliases", { phrases: p.aliases.phrases, starts: p.aliases.starts });
  write("phrases", { phrases: p.phrases });
  write("apps", { nicknames: p.nicknames });
  write("dictation", { ends: p.dictationEnds });
  write("sites", { sites: p.sites });
  write("actions", { off: p.off });
  write("wishlist", { requests: p.wishlist });
  write("review", { decided: p.decided });
}

/** The profile files, for a backup before a change. */
export const PROFILE_FILES = Object.values(FILES);
