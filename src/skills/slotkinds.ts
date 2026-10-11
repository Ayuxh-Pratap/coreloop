/**
 * Slot kinds: how the words a template captured become a slot, implemented once in the core so a skill can
 * declare them as data. Every kind only cuts, matches or parses the user's own words; none can produce a word the
 * user didn't say. A kind that can't make sense of the words makes the template not match, so the next
 * template (or the model) gets a chance.
 *
 *   words     the captured words as said ("ask cursor to {span}")
 *   search    what to look for, without descriptions or quantities ("Panther, who is a music artist" → "panther")
 *   name      a thing's name, as the action's own nouns call it (`SkillAction.nouns`: a music skill's "song",
 *             "artist"); "its songs" / "this artist" mean the last search; the value "@here" means the last search,
 *             else whatever is current ("@current", for the surface to resolve)
 *   app       an app the surface knows, named as a whole (by name, alias or sound); fills `app` and `app_id`
 *   site      a website, through the URL parser; fills `url`
 *   position  a place in a list: "first", "second", "top", "3" → 1..10, and "last" → -1
 *   item      one of the surface's items: by position, shared words or sound in code; else the model's pick,
 *             if confident and pointed at by the words. Fills `<name>` (the id) and `<name>_label`
 */
import { nameApp } from "../core/apps.ts";
import { itemPickOk, matchItem, type Item } from "../core/items.ts";
import { parseNumber, parseOrdinal, parseUrl } from "../core/parse.ts";
import type { Slots } from "../core/slots.ts";
import { cleanQuery, nameQuery } from "./query.ts";
import type { CheckCtx } from "./types.ts";

/**
 * How the words a template captured become a slot. Every kind only cuts, matches or parses the user's own words:
 * `words` (as said), `search` (what to look for), `name` (a thing's name; "its songs" means the last search), `app`
 * (a place the surface knows), `site` (a website or address), `position` (1 to 10, or -1 for "last") and `item` (one
 * of the items on screen). A kind that can't make sense of the words makes the template not match.
 */
export const SLOT_KINDS = ["words", "search", "name", "app", "site", "position", "item"] as const;
/** One of `SLOT_KINDS`. */
export type SlotKind = (typeof SLOT_KINDS)[number];

/** The slot(s) one captured value becomes, or undefined when the words don't fit the kind. */
export function resolveSlot(kind: SlotKind, name: string, value: string, ctx: CheckCtx, nouns: readonly string[] = []): Partial<Slots> | undefined {
  const v = value.trim();
  switch (kind) {
    case "words":
      return v ? { [name]: v } : undefined;
    case "search": {
      const q = cleanQuery(v, nouns);
      return q ? { [name]: q } : undefined;
    }
    case "name": {
      if (v === "@here") return { [name]: ctx.lastQuery ?? "@current" };
      const q = nameQuery(v, ctx, nouns);
      return q ? { [name]: q } : undefined;
    }
    case "app": {
      const hit = nameApp(v.replace(/ (?:app|window)$/, ""), ctx.apps);
      return hit ? { app: hit.app.name, app_id: hit.app.id } : undefined;
    }
    case "site": {
      const url = parseUrl(v);
      return url ? { url } : undefined;
    }
    case "item": {
      const items = ctx.items ?? [];
      const as = (i: Item) => ({ [name]: i.id, [`${name}_label`]: i.label });
      if (ctx.forceItem) {
        const forced = items.find((i) => i.id === ctx.forceItem);
        return forced ? as(forced) : undefined;
      }
      const hit = matchItem(v, items, ctx.excludeItems);
      if (hit) return as(hit);
      // the model's pick: the best one not ruled out, if it passes the gates
      const a = ctx.itemAnswer;
      const top = a?.ranked.find((r) => r.option !== "none" && !ctx.excludeItems?.includes(r.option));
      const item = top && items.find((i) => i.id === top.option);
      return item && a && itemPickOk(item, v, a.confidence, top!.p) ? as(item) : undefined;
    }
    case "position": {
      const n = v === "top" ? 1 : (parseOrdinal(v) ?? parseNumber(v));
      // 1 to 10, or -1 for "last": the surface counts it from the end of its list
      return n !== undefined && ((n >= 1 && n <= 10) || n === -1) ? { [name]: n } : undefined;
    }
  }
}
