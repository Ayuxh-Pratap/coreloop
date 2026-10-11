/**
 * The learning loop's review: the journal turns into proposals, and I decide each one.
 *
 *   npm run review                  go through the proposals: [a]ccept, [e]dit, [r]eject, [s]kip, [q]uit
 *   npm run review -- --list        only list them
 *   npm run review -- --days 7      only the last week of the journal
 *
 * Accepted proposals become profile data (profile/) plus a case in eval/personal.jsonl, both mine and gitignored. Then every eval set runs
 * again, and the change is kept only if no set got worse; otherwise everything is put back as it was. Rejected
 * proposals are remembered and not offered again. Nothing changes without my "accept".
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { SystemOneClient } from "../backends/systemone.ts";
import { config } from "../config.ts";
import { DEFAULT_JOURNAL, readJournal } from "../journal/journal.ts";
import { PROFILE_FILES, profileDir, saveProfile, useProfileFiles } from "../host/profile-files.ts";
import { runAll, worse, type SetScore } from "../review/gate.ts";
import { accept, propose, reject, type PersonalCase, type Proposal } from "../review/proposals.ts";
import { stillMissing } from "../review/replay.ts";
import { fixtureApps } from "../sim/fixture.ts";
import { SIM_SKILLS } from "../sim/skills.ts";
import { SkillSet } from "../skills/skillset.ts";

const { values } = parseArgs({ options: { list: { type: "boolean", default: false }, days: { type: "string" }, journal: { type: "string" } } });
const PERSONAL = join("eval", "personal.jsonl");

const since = values.days ? Date.now() - Number(values.days) * 86_400_000 : 0;
const lines = readJournal(values.journal ?? DEFAULT_JOURNAL.dir).filter((l) => l.t >= since);
let prof = useProfileFiles();
const found = propose(lines, prof, fixtureApps());

// replay: only what today's core still gets wrong is worth a decision
const client = new SystemOneClient({ baseUrl: config.decider.url, timeoutMs: config.decider.timeoutMs });
const modelUp = (await client.health()).ok;
const replayed = modelUp ? await stillMissing(found, client, { apps: fixtureApps(), skills: new SkillSet(SIM_SKILLS) }) : { keep: found, handled: [] };
const proposals = replayed.keep;

const presses = lines.filter((l) => l.type === "press").length;
console.log(`\n${presses} presses in the journal${values.days ? ` (last ${values.days} days)` : ""} → ${proposals.length} proposal(s)`);
console.log(modelUp ? `  ${replayed.handled.length} more the core already handles today, so not proposed\n` : "  (model server not running: not replayed against today's core)\n");
if (!proposals.length) process.exit(0);

const show = (p: Proposal, i: number) => {
  console.log(`${i + 1}. [${p.kind}] ${p.title}   (${p.evidence.length}×)`);
  for (const e of p.evidence.slice(0, 3)) console.log(`     ${e.at}  "${e.said}"${e.then ? ` → then "${e.then}"` : ""}`);
  console.log(`     becomes an eval case: "${p.case.said}" → ${JSON.stringify(p.case.expect)}`);
};

if (values.list) {
  proposals.forEach(show);
  process.exit(0);
}

console.log("profile/ and eval/personal.jsonl stay on this machine (gitignored, never published).\n");
const rl = createInterface({ input: process.stdin, terminal: false });
// answers come line by line from the terminal or a pipe; a line typed ahead is never lost
const answers = rl[Symbol.asyncIterator]();
const answer = async (q: string) => {
  process.stdout.write(q);
  const next = await answers.next();
  if (!process.stdin.isTTY) process.stdout.write(`${next.done ? "" : next.value}\n`); // echo piped answers
  return next.done ? "q" : next.value.trim();
};
const ask = async (q: string, fallback: string) => (await answer(`     ${q} [${fallback}]: `)) || fallback;

/** A proposal changed by hand. */
async function edit(p: Proposal): Promise<Proposal> {
  const kase = { ...p.case, said: await ask("eval case: what I said", p.case.said) };
  if (p.kind === "mishearing") {
    const heard = await ask("heard", p.heard);
    const meant = await ask("meant", p.meant);
    return { ...p, heard, meant, key: `mishearing:${heard}=>${meant}`, case: kase };
  }
  if (p.kind === "nickname") return { ...p, name: await ask("nickname", p.name), case: kase };
  if (p.kind === "phrase") return { ...p, does: await ask("means the command", p.does), case: kase };
  if (p.kind === "request") return { ...p, what: await ask("wish", p.what), case: kase };
  return { ...p, case: { ...kase, expect: JSON.parse(await ask("expected (JSON)", JSON.stringify(p.case.expect))) as Record<string, string> } };
}

const accepted: Proposal[] = [];
for (const [i, p] of proposals.entries()) {
  show(p, i);
  const a = (await answer("   [a]ccept [e]dit [r]eject [s]kip [q]uit: ")).toLowerCase();
  if (a === "q") break;
  if (a === "a") accepted.push(p);
  else if (a === "e") accepted.push(await edit(p));
  else if (a === "r") prof = reject(prof, p);
}
rl.close();
if (proposals.some((p) => prof.decided[p.key] === "rejected")) saveProfile(prof); // rejections are always safe to remember

if (!accepted.length) {
  console.log("\nnothing accepted, nothing changed.");
  process.exit(0);
}

if (!(await client.health()).ok) {
  console.error(`\nthe model server isn't running, so the change can't be checked and isn't made. Start it (npm run models:start) and review again.`);
  process.exit(1);
}

const line = (s: SetScore) => `  ${s.set.padEnd(17)} ${s.of - s.misses}/${s.of} right · ${s.wrong} wrong`;
console.log("\nevery eval set, before the change:");
const before = await runAll((s) => console.log(line(s)));

// keep what's on disk, to put back if the change makes anything worse
const files = [...PROFILE_FILES.map((f) => join(profileDir(), f)), PERSONAL];
const backup = new Map(files.map((f) => [f, (() => { try { return readFileSync(f, "utf8"); } catch { return undefined; } })()]));

let next = prof;
for (const p of accepted) next = accept(next, p);
saveProfile(next);
const existing = readFileSync(PERSONAL, "utf8");
let n = (existing.match(/"id":"p-learned-\d+"/g) ?? []).length;
const cases: PersonalCase[] = accepted.map((p) => ({ id: `p-learned-${String(++n).padStart(2, "0")}`, ...p.case }));
writeFileSync(PERSONAL, existing.replace(/\s*$/, "\n") + cases.map((c) => JSON.stringify(c)).join("\n") + "\n");

console.log("\nafter:");
const after = await runAll((s) => console.log(line(s)));
const problems = worse(before, after);
if (problems.length) {
  for (const [f, text] of backup) if (text !== undefined) writeFileSync(f, text);
  console.log(`\nput back: the change made ${problems.join("; ")}. Nothing changed; the proposals will come up again.`);
  process.exit(1);
}
console.log(`\nkept: ${accepted.length} change(s) in profile/ and ${cases.length} new case(s) in eval/personal.jsonl. They stay on this machine.`);
