/**
 * Where a running core says how to reach it: ~/.coreloop/session.json holds the port and the per-launch token,
 * in the user's own profile, written when the core starts and removed when it stops. A local surface reads it to
 * connect; a web page can't, which is the point.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Session {
  port: number;
  token: string;
  pid: number;
}

export const SESSION_FILE = join(homedir(), ".coreloop", "session.json");

export function writeSession(s: Session, file = SESSION_FILE): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(s), { mode: 0o600 });
}

export function readSession(file = SESSION_FILE): Session | undefined {
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Session;
    return typeof s.port === "number" && typeof s.token === "string" ? s : undefined;
  } catch {
    return undefined;
  }
}

export function removeSession(file = SESSION_FILE): void {
  rmSync(file, { force: true });
}
