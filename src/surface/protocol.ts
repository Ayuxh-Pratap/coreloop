/**
 * The surface protocol, contract v2 (places and paths): how a surface in another process (the Windows desktop, a browser
 * extension, a Next.js app) talks to the core over a loopback WebSocket. The same contract as in-process
 * (src/surface/contract.ts), as JSON messages.
 *
 *   surface → core   hello   { type, v, token, name, skills, operations?, inside? }   first message, within 3 s
 *   core → surface   welcome { type, v, token }
 *   core → surface   call    { type, id, token, method: "view" | "plan" | "run", params }
 *   core → surface   call    { type, token, method: "prefetch" }                      no answer expected
 *   surface → core   result  { type, id, token, ok: true, value } | { …, ok: false, error: { kind, message } }
 *
 * Every message carries the per-launch token, both ways. Everything a surface sends is untrusted: it is checked
 * here before the core uses it (skills through the skill validator, views and plans by shape and size), and page,
 * window and app text stays data (labels are options, never the model's state).
 */
import { ALL_COMMON } from "../core/operations.ts";
import { parseSkills } from "../skills/validate.ts";
import type { Skill } from "../skills/types.ts";
import type { Assume, Decided, Plan, Receipt, SurfaceView } from "./contract.ts";

/** The wire protocol's version. A surface built for v2 keeps working until a v3 is announced. */
export const PROTOCOL_VERSION = 2;

/** The largest message, in bytes. A bigger one closes the connection. */
export const MAX_MESSAGE_BYTES = 1_000_000;
const MAX_ITEMS = 500;
const MAX_PLACES = 2_000;
const MAX_PATH = 10;
const MAX_TEXT = 300;

/** What the core can call on a surface. */
export type Method = "view" | "plan" | "run";

/** The surface's first message, within 3 seconds: who it is and what it can do. */
export interface Hello {
  type: "hello";
  /** The protocol version: `PROTOCOL_VERSION`. */
  v: number;
  /** This launch's token. */
  token: string;
  /** The surface's name. */
  name: string;
  /** Its skills, as data. */
  skills: Skill[];
  /** The common operations it supports. Default: all. */
  operations?: string[];
  /** The place it lives in ("Brave" for a browser extension, "localhost:3000" for a web app); none for the outermost. */
  inside?: string;
}
/** The core's answer to a good hello. */
export interface Welcome {
  type: "welcome";
  v: number;
  token: string;
}
/** The core asks the surface to view, plan or run. `prefetch` expects no answer. */
export interface Call {
  type: "call";
  id?: number;
  token: string;
  method: Method | "prefetch";
  params?: { action?: Decided; assume?: Assume; plan?: Plan };
}
/** The surface's answer to a call: a value, or an error whose kind is `plan` (a `PlanError`) or `error`. */
export type Result =
  | { type: "result"; id: number; token: string; ok: true; value: unknown }
  | { type: "result"; id: number; token: string; ok: false; error: { kind: "plan" | "error"; message: string } };

/** A message that breaks the protocol. Its message says what was wrong. */
export class ProtocolError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = MAX_TEXT): v is string => typeof v === "string" && v.length <= max;
const strList = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every((s) => isStr(s));

/** A message as JSON, or a ProtocolError. */
export function parseMessage(raw: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ProtocolError("not JSON");
  }
  if (!isObj(data) || !isStr(data.type, 20)) throw new ProtocolError("a message needs a type");
  return data;
}

/** A hello, checked: version, name, skills (through the skill validator), operations (common ones only). */
export function parseHello(m: Record<string, unknown>): Hello {
  if (m.type !== "hello") throw new ProtocolError("the first message must be hello");
  if (m.v !== PROTOCOL_VERSION) throw new ProtocolError(`protocol version ${String(m.v)} is not ${PROTOCOL_VERSION}`);
  if (!isStr(m.name, 80) || !m.name) throw new ProtocolError("hello needs a name");
  if (!isStr(m.token, 200)) throw new ProtocolError("hello needs the token");
  const skills = parseSkills(m.skills, `${m.name} skills`);
  if (m.operations !== undefined && (!strList(m.operations, 50) || !m.operations.every((o) => ALL_COMMON.includes(o)))) {
    throw new ProtocolError("operations must be common operations");
  }
  if (m.inside !== undefined && (!isStr(m.inside, 120) || !m.inside)) throw new ProtocolError("inside must be a place name");
  return { type: "hello", v: PROTOCOL_VERSION, token: m.token, name: m.name, skills, operations: m.operations as string[] | undefined, inside: m.inside as string | undefined };
}

/** A view from a surface, checked by shape and size. */
export function parseView(v: unknown): SurfaceView {
  if (!isObj(v)) throw new ProtocolError("a view must be an object");
  if (!Array.isArray(v.places) || v.places.length > MAX_PLACES) throw new ProtocolError("view.places must be a list");
  for (const a of v.places) {
    if (!isObj(a) || !isStr(a.name) || !a.name || !isStr(a.id, 1000)) throw new ProtocolError("each place needs a name and an id");
    if (a.kind !== undefined && (!isStr(a.kind, 40) || !a.kind)) throw new ProtocolError("place.kind must be a word");
    if (a.aliases !== undefined && !strList(a.aliases, 20)) throw new ProtocolError("place aliases must be a list of names");
    if (a.generic !== undefined && !strList(a.generic, 20)) throw new ProtocolError("place.generic must be a list of words");
  }
  if (v.path !== undefined && (!strList(v.path, MAX_PATH) || v.path.some((p) => !p))) throw new ProtocolError(`view.path must be a list of at most ${MAX_PATH} place names`);
  if (!strList(v.open, MAX_PLACES)) throw new ProtocolError("view.open must be a list of place names");
  if (v.items !== undefined) {
    if (!Array.isArray(v.items) || v.items.length > MAX_ITEMS) throw new ProtocolError(`view.items must be a list of at most ${MAX_ITEMS}`);
    for (const i of v.items) {
      if (!isObj(i) || !isStr(i.id, 100) || !i.id || !isStr(i.label) || !isStr(i.role, 40)) throw new ProtocolError("each item needs an id, a label and a role");
      if (i.group !== undefined && !isStr(i.group, 40)) throw new ProtocolError("item.group must be a string");
      if (i.app !== undefined && !isStr(i.app)) throw new ProtocolError("item.app must be a place name");
    }
  }
  return v as unknown as SurfaceView;
}

/** A plan from a surface: what people are shown must be text; its own steps are opaque JSON. */
export function parsePlan(p: unknown, depth = 0): Plan {
  if (!isObj(p) || !isStr(p.summary, 1000)) throw new ProtocolError("a plan needs a summary");
  if (!strList(p.detail, 100)) throw new ProtocolError("plan.detail must be a list of steps in words");
  if (p.shows !== undefined && !isStr(p.shows)) throw new ProtocolError("plan.shows must be a place name");
  if (p.undo !== undefined) {
    if (depth > 3) throw new ProtocolError("plan.undo nests too deep");
    parsePlan(p.undo, depth + 1);
  }
  return p as unknown as Plan;
}

/** A receipt from a surface. */
export function parseReceipt(r: unknown): Receipt {
  if (!isObj(r) || typeof r.ok !== "boolean") throw new ProtocolError("a receipt needs ok");
  if (r.notes !== undefined && !strList(r.notes, 20)) throw new ProtocolError("receipt.notes must be a list of text");
  if (r.error !== undefined && !isStr(r.error, 1000)) throw new ProtocolError("receipt.error must be text");
  return r as unknown as Receipt;
}
