import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { matchApps } from "../src/core/apps.ts";
import { normalise } from "../src/core/normalise.ts";
import { parseUrl } from "../src/core/parse.ts";
import { resolveSlots } from "../src/core/slots.ts";
import { FIXTURE_PROFILE, loadProfile, saveProfile, useProfileFiles } from "../src/host/profile-files.ts";
import { checkProfile, currentProfile, EMPTY_PROFILE, ProfileError, useProfile, type Profile } from "../src/profile/profile.ts";
import { fixtureApps } from "../src/sim/fixture.ts";
import { SIM_SKILLS } from "../src/sim/skills.ts";
import { commonOnly, SkillSet } from "../src/skills/skillset.ts";

// a profile of my own, in a folder of its own, handed to the engine
const dir = mkdtempSync(join(tmpdir(), "coreloop-profile-"));
const mine: Profile = {
  aliases: { phrases: { "claude code": ["plot code"] }, starts: {} },
  phrases: [{ say: "make it louder", do: "volume up" }],
  nicknames: { Obsidian: ["my notes"] },
  dictationEnds: ["command", "full stop"],
  sites: { "my dashboard": "localhost:3000/admin" },
  off: ["spotify.like", "close_app"],
  wishlist: [],
  decided: {},
};
saveProfile(mine, dir);
useProfile(loadProfile(dir));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  useProfileFiles(FIXTURE_PROFILE); // back to the fixture profile for the other tests
});

describe("my profile", () => {
  it("round-trips through its files", () => {
    expect(loadProfile(dir)).toEqual(mine);
  });

  it("turns a sentence of mine into the command it means, which then goes through every rule", () => {
    const n = normalise("Make it louder please.");
    expect(n.text).toBe("volume up");
    expect(n.fixes).toContain('"make it louder" means "volume up"');
    expect(normalise("open plot code").text).toBe("open claude code");
  });

  it("knows my nicknames for apps, and only as app names", () => {
    expect(matchApps("my notes", fixtureApps())[0]!.app.name).toBe("Obsidian");
    expect(normalise("type my notes are done").text).toBe("type my notes are done");
  });

  it("knows the sites I name, and only those", () => {
    expect(parseUrl("open my dashboard")).toBe("localhost:3000/admin");
    expect(parseUrl("open gmail")).toBeUndefined();
    expect(parseUrl("open example dot com")).toBe("example.com");
    expect(() => checkProfile({ ...mine, sites: { gmail: "https://mail.google.com" } })).toThrow(ProfileError);
    expect(() => checkProfile({ ...mine, sites: { Gmail: "mail.google.com" } })).toThrow(ProfileError);
  });

  it("drops the words I add after dictation, only from the end and only when enough is left", () => {
    expect(resolveSlots("type_text", "type npm run dev command").span).toBe("npm run dev");
    expect(resolveSlots("type_text", "type see you tomorrow full stop").span).toBe("see you tomorrow");
    expect(resolveSlots("type_text", "type git status command").span).toBe("git status");
    expect(resolveSlots("type_text", "type the command").span).toBe("the command");
    expect(resolveSlots("type_text", "type command line tools").span).toBe("command line tools");
    expect(() => checkProfile({ ...mine, dictationEnds: ["Command"] })).toThrow(ProfileError);
  });

  it("never decides or offers what I turned off", () => {
    const sk = new SkillSet(SIM_SKILLS);
    expect(sk.action("spotify.like")).toBeUndefined();
    expect(sk.supports("close_app")).toBe(false);
    expect(sk.modelOptions().map((o) => o.id)).not.toContain("close_app");
    expect(sk.supports("confirm")).toBe(true);
    expect(commonOnly().supports("close_app")).toBe(false);
  });

  it("refuses a profile that would take away confirm, or a phrase that means itself", () => {
    expect(() => checkProfile({ ...mine, off: ["confirm"] })).toThrow(ProfileError);
    expect(() => checkProfile({ ...mine, phrases: [{ say: "x", do: "x" }] })).toThrow(ProfileError);
    expect(() => useProfile({ ...mine, off: ["cancel"] })).toThrow(ProfileError);
  });

  it("runs with an empty profile when nobody hands one in", () => {
    const before = currentProfile();
    useProfile(EMPTY_PROFILE);
    expect(normalise("open plot code").text).toBe("open plot code");
    expect(normalise("open clawed app").text).toBe("open clawed app");
    expect(parseUrl("open youtube")).toBeUndefined();
    expect(resolveSlots("type_text", "type npm run dev command").span).toBe("npm run dev command");
    expect(new SkillSet(SIM_SKILLS).action("spotify.like")).toBeDefined();
    useProfile(before);
  });
});
