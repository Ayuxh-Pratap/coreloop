import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The engine boundary: the engine is what every surface shares, in Node, in a browser, inside a
 * website. Its runtime imports must stay inside it: no Node modules, no packages, no native addons, and nothing from
 * the host (server, audio, journal, CLI), the simulated surfaces or the evals.
 */
const ENGINE_ENTRIES = [
  "src/index.ts",
  "src/backends/codeonly.ts",
  "src/core/pipeline.ts",
  "src/core/policy.ts",
  "src/live/actor.ts",
  "src/surface/contract.ts",
  "src/surface/router.ts",
  "src/surface/protocol.ts",
  "src/surface/client.ts",
  "src/surface/conformance.ts",
  "src/skills/validate.ts",
  "src/profile/profile.ts",
  "src/backends/systemone.ts",
];
/** Where engine code may live. */
const ENGINE_PATHS = [
  /^src\/index\.ts$/,
  /^src\/core\//,
  /^src\/skills\//,
  /^src\/surface\//,
  /^src\/profile\/profile\.ts$/,
  /^src\/live\/actor\.ts$/,
  /^src\/backends\/(?:systemone|codeonly)\.ts$/,
];

const posix = (p: string) => p.replace(/\\/g, "/");

/** Runtime import specifiers of a file: type-only imports and exports are erased, so they don't count. */
function runtimeImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gm)) {
    if (m[2]) continue; // import type … / export type …
    out.push(m[4]!);
  }
  for (const m of src.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push(m[1]!); // side-effect imports
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!); // dynamic imports
  return out;
}

function closure(): { files: Set<string>; problems: string[] } {
  const files = new Set<string>();
  const problems: string[] = [];
  const todo = [...ENGINE_ENTRIES];
  while (todo.length) {
    const file = todo.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!ENGINE_PATHS.some((p) => p.test(file))) problems.push(`${file} is in the engine's imports but outside the engine`);
    for (const spec of runtimeImports(file)) {
      if (!spec.startsWith(".")) {
        problems.push(`${file} imports "${spec}" (the engine imports no Node modules or packages)`);
        continue;
      }
      todo.push(posix(relative(".", join(dirname(file), spec))));
    }
  }
  return { files, problems };
}

describe("the engine boundary", () => {
  it("imports only engine code: no Node, packages, host, surfaces or evals", () => {
    const { files, problems } = closure();
    expect(problems).toEqual([]);
    expect(files.size).toBeGreaterThan(20);
  });

  it("uses no Node globals", () => {
    const { files } = closure();
    const hits = [...files].flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => ({ line: line.replace(/\/\/.*$|^\s*\*.*$/, ""), at: `${f}:${i + 1}` }))
        .filter(({ line }) => /\bprocess\.|\bBuffer\b|\bNodeJS\.|\brequire\(|__dirname|__filename/.test(line))
        .map((h) => h.at),
    );
    expect(hits).toEqual([]);
  });

  it("type-checks as browser code (tsconfig.engine.json: no Node types)", () => {
    const tsc = join("node_modules", "typescript", "bin", "tsc");
    expect(() => execFileSync(process.execPath, [tsc, "--noEmit", "-p", "tsconfig.engine.json"], { encoding: "utf8", stdio: "pipe" })).not.toThrow();
  }, 60_000);
});
