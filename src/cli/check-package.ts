/**
 * Is coreloop-engine ready to publish?
 *
 *   npm run check:package
 *
 * Builds the package from the engine's files, then checks:
 *   - the built entry exports exactly what src/index.ts exports;
 *   - nothing in dist/ imports a Node module or a package (it runs in a browser too);
 *   - it has no dependencies;
 *   - the tarball holds only dist/, the README, LICENSE and NOTICE;
 *   - the example surface (examples/hello-surface.ts) runs on the built package and passes conformance.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PKG = "packages/engine";
const results: [string, string | undefined][] = [];
const check = async (name: string, fn: () => Promise<string | undefined> | string | undefined) => {
  try {
    results.push([name, await fn()]);
  } catch (err) {
    results.push([name, (err as Error).message.split("\n")[0]]);
  }
};
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

await check("it builds", () => {
  const r = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", join(PKG, "tsconfig.json")], { encoding: "utf8" });
  return r.status === 0 ? undefined : (r.stdout || r.stderr).split("\n").slice(0, 3).join(" ");
});

await check("the built entry exports exactly src/index.ts", async () => {
  const built = Object.keys(await import(pathToFileURL(join(PKG, "dist/index.js")).href)).sort();
  const source = Object.keys(await import(pathToFileURL("src/index.ts").href)).sort();
  const missing = source.filter((k) => !built.includes(k));
  const extra = built.filter((k) => !source.includes(k));
  return missing.length || extra.length ? `missing ${missing.join(", ") || "-"}; extra ${extra.join(", ") || "-"}` : undefined;
});

await check("dist/ imports no Node module and no package", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".js") ? [join(d, f)] : []));
  const bad = walk(join(PKG, "dist")).flatMap((f) =>
    [...readFileSync(f, "utf8").matchAll(/(?:^|\n)\s*(?:import|export)[^"'\n]*from\s*["']([^"']+)["']/g)].map((m) => m[1]!).filter((s) => !s.startsWith("./") && !s.startsWith("../")).map((s) => `${f}: ${s}`),
  );
  return bad.length ? bad.slice(0, 3).join("; ") : undefined;
});

await check("no dependencies", () => {
  const p = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as Record<string, unknown>;
  const deps = ["dependencies", "peerDependencies", "optionalDependencies"].filter((k) => p[k] && Object.keys(p[k] as object).length);
  return deps.length ? `has ${deps.join(", ")}` : undefined;
});

await check("the tarball holds only dist/, README, LICENSE and NOTICE", () => {
  const out = execFileSync(npm, ["pack", "--dry-run", "--json", "-w", "coreloop-engine"], { encoding: "utf8", shell: process.platform === "win32" });
  const files = (JSON.parse(out) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path);
  const allowed = (f: string) => f.startsWith("dist/") || ["README.md", "LICENSE", "NOTICE", "package.json"].includes(f);
  const bad = files.filter((f) => !allowed(f));
  if (!files.includes("README.md") || !files.includes("LICENSE")) return "README.md or LICENSE missing";
  return bad.length ? `unexpected: ${bad.slice(0, 5).join(", ")}` : undefined;
});

await check("the example surface runs on the built package", () => {
  const r = spawnSync(process.execPath, ["examples/hello-surface.ts"], { encoding: "utf8" });
  if (r.status !== 0) return (r.stderr || r.stdout).split("\n").slice(0, 2).join(" ");
  if (r.stdout.includes("✖")) return "a conformance check failed";
  return r.stdout.includes("notes now:") ? undefined : "it didn't finish";
});

for (const [name, problem] of results) console.log(`${problem ? "✖" : "✔"} ${name}${problem ? `: ${problem}` : ""}`);
const failed = results.filter(([, p]) => p).length;
console.log(failed ? `\n${failed} check(s) failed` : "\ncoreloop-engine is ready to publish");
process.exit(failed ? 1 : 0);
