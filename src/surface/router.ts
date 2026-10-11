/**
 * Several surfaces at once (contract v2): one mic and one model, each command carried out by one surface.
 * `Surfaces` is itself a Surface, so the actor, the questions, the memory and the confirms work exactly as with one.
 *
 * Surfaces are given outermost first: the desktop, then what lives inside it. Each inner surface says which place it
 * lives in (`inside`: "Brave" for the browser, "localhost:3000" for my web app in a tab), and the paths chain by it:
 *
 *   desktop  ["Brave"]  +  browser (inside Brave)  ["Brave", "localhost:3000"]  +  web app (inside localhost:3000)
 *   ["Pricing"]  =  ["Brave", "localhost:3000", "Pricing"]
 *
 * Only a surface whose place is on the path joins it, so the web app counts only while its tab is in front.
 *
 * Which surface carries out a decided action:
 *   - a skill action: the surface that declared it;
 *   - a common operation for a place that was named: the innermost surface that knows that place, if it supports the
 *     operation ("open pricing" on my web app, "open Spotify" on the desktop);
 *   - otherwise along the path, innermost first: the first surface on it that supports the operation ("search for X"
 *     goes to the page, "mute" to the desktop); else the first surface that does at all.
 */
import type { AppEntry } from "../core/apps.ts";
import type { Item } from "../core/items.ts";
import { ALL_COMMON } from "../core/operations.ts";
import type { Skill } from "../skills/types.ts";
import { PlanError, type Assume, type Decided, type Plan, type Receipt, type Surface, type SurfaceView } from "./contract.ts";
import { step } from "../core/trace.ts";

/** A plan made by one of the surfaces, so `run` (and its undo) goes back to that surface. */
interface Routed {
  via: number;
  plan: Plan;
}

/**
 * Several surfaces as one. Paths chain by containment (a surface joins where its `inside` is on the path), views merge
 * with the inner surface winning, and each action goes to the surface that can carry it out.
 *
 * @example
 * const actor = new Actor({ client, surface: new Surfaces([desktop, browser, webApp]) });
 */
export class Surfaces implements Surface {
  readonly name: string;
  /** Every surface's skills, inner surfaces first. */
  readonly skills: readonly Skill[];
  /** Every surface's common operations together. */
  readonly operations: readonly string[];
  private readonly list: readonly Surface[];
  /** Which surface declared each skill action. */
  private readonly declaredBy = new Map<string, number>();
  private views: readonly SurfaceView[] = [];
  /** Each surface's places that count now (see view). */
  private named: readonly (readonly AppEntry[])[] = [];
  private path: readonly string[] = [];

  constructor(surfaces: readonly Surface[]) {
    if (surfaces.length === 0) throw new Error("no surfaces");
    this.list = surfaces;
    this.name = surfaces.map((s) => s.name).join(" + ");
    // innermost first, so an inner surface's skill is tried before an outer one for the same place
    this.skills = [...surfaces].reverse().flatMap((s) => s.skills);
    surfaces.forEach((s, i) => s.skills.forEach((k) => k.actions.forEach((a) => this.declaredBy.set(a.id, i))));
    this.operations = [...new Set(surfaces.flatMap((s) => s.operations ?? ALL_COMMON))];
  }

  /** The surfaces, outermost first. */
  get surfaces(): readonly Surface[] {
    return this.list;
  }

  prefetch(): void {
    for (const s of this.list) s.prefetch?.();
  }

  async view(): Promise<SurfaceView> {
    const views = await Promise.all(this.list.map((s) => s.view()));
    this.views = views;
    // the places: one entry per name, with every surface's spoken names and noise words. A name an inner surface
    // declares is its own: "the browser" from the extension inside Brave is no longer the desktop's Chrome.
    const { path, joined } = chainOf(this.list, views);
    this.path = path;
    // An inner surface's places count while the user is in it (my web app's "Settings" route only while its tab is
    // in front); the place it lives in counts always ("the browser" from any app).
    const named = views.map((v, i) => (i === 0 || joined.includes(i) ? v.places : v.places.filter((p) => p.name === this.list[i]!.inside)));
    this.named = named;
    const claimed = new Map<string, string>();
    for (const list of [...named].reverse()) for (const a of list) for (const n of a.aliases ?? []) if (!claimed.has(n.toLowerCase())) claimed.set(n.toLowerCase(), a.name);
    // one entry per name; the innermost surface's entry is the place ("Settings" is my app's route while I'm in it)
    const places = new Map<string, AppEntry>();
    for (const list of [...named].reverse()) {
      for (const a of list) {
        const had = places.get(a.name);
        const aliases = [...new Set([...(had?.aliases ?? []), ...(a.aliases ?? [])])].filter((n) => claimed.get(n.toLowerCase()) === a.name);
        const generic = [...new Set([...(had?.generic ?? []), ...(a.generic ?? [])])];
        const { aliases: _a, generic: _g, ...rest } = had ?? a;
        places.set(a.name, { ...rest, ...(aliases.length ? { aliases } : {}), ...(generic.length ? { generic } : {}) });
      }
    }
    // Items belong to the place the surface showing them is for (the browser's page: Brave), so the core offers only
    // the target's. Along the path, the innermost surface that shows any wins: my web app's own items, not the
    // browser's reading of the same page.
    const inner = [...joined].reverse().find((i) => views[i]!.items?.length);
    const items: Item[] = views.flatMap((v, i) => {
      if (inner !== undefined && joined.includes(i) && i !== inner) return [];
      const at = v.path?.[0] ?? this.list[i]!.inside;
      return (v.items ?? []).map((it) => (it.app || !at ? it : { ...it, app: at }));
    });
    step("route", "router.path", `where I am across ${joined.length} of ${this.list.length} surfaces`, { path: this.path, surfaces: joined.map((i) => `${this.list[i]!.name}${this.list[i]!.inside ? ` (inside ${this.list[i]!.inside})` : ""}`) });
    return {
      places: [...places.values()],
      path: this.path,
      open: [...new Set(views.flatMap((v) => v.open))],
      ...(items.length ? { items } : {}),
    };
  }

  /** The innermost surface that knows the place (reports it, is in it, or has a skill for it); else the outermost. */
  private owner(place: string): number {
    for (let i = this.list.length - 1; i > 0; i--) {
      const v = this.views[i];
      if (this.named[i]?.some((p) => p.name === place) || v?.path?.includes(place) || this.list[i]!.skills.some((k) => k.places.includes(place))) return i;
    }
    return 0;
  }

  private supports(i: number, operation: string): boolean {
    return (this.list[i]!.operations ?? ALL_COMMON).includes(operation);
  }

  /** Which surface carries out this action: its index, outermost first. */
  route(action: Decided, assume?: Assume): number {
    const declared = this.declaredBy.get(action.operation);
    if (declared !== undefined) return declared;
    const named = action.slots.app;
    if (named) {
      const owner = this.owner(named);
      if (this.supports(owner, action.operation)) return owner;
    } else {
      for (const place of [...(assume?.path ?? this.path)].reverse()) {
        const owner = this.owner(place);
        if (this.supports(owner, action.operation)) return owner;
      }
    }
    const any = this.list.findIndex((_, i) => this.supports(i, action.operation));
    if (any < 0) throw new PlanError(`nothing connected can ${action.operation.replace(/_/g, " ")}`);
    return any;
  }

  async plan(action: Decided, assume?: Assume): Promise<Plan> {
    const via = this.route(action, assume);
    const why = this.declaredBy.has(action.operation) ? "it declared this action" : action.slots.app ? `it knows ${action.slots.app} and can ${action.operation}` : "the innermost surface on the path that can";
    step("route", "router.route", `${this.list[via]!.name} carries it out: ${why}`, { operation: action.operation, surface: this.list[via]!.name });
    return wrap(via, await this.list[via]!.plan(action, assume));
  }

  async run(plan: Plan): Promise<Receipt> {
    const routed = plan.data as Routed | undefined;
    if (!routed || typeof routed.via !== "number") return { ok: false, error: "a plan no surface made" };
    return this.list[routed.via]!.run(routed.plan);
  }

  afterTurn(): void {
    for (const s of this.list) s.afterTurn?.();
  }
}

/**
 * Where the user is across the surfaces: the outermost one's path, then each surface living in a place on it
 * (its `inside`), innermost last. A surface whose place isn't on the path isn't where the user is.
 */
export function chain(surfaces: readonly Surface[], views: readonly SurfaceView[]): string[] {
  return chainOf(surfaces, views).path;
}

/** The path, and which surfaces are on it, outermost first. */
function chainOf(surfaces: readonly Surface[], views: readonly SurfaceView[]): { path: string[]; joined: number[] } {
  let path = [...(views[0]?.path ?? [])];
  const joined = [0];
  for (let grew = true; grew; ) {
    grew = false;
    for (let i = 1; i < surfaces.length; i++) {
      const inside = surfaces[i]!.inside;
      if (joined.includes(i) || inside === undefined || !path.includes(inside)) continue;
      const own = views[i]?.path ?? [];
      const rest = own[0] === inside ? own.slice(1) : own;
      path = [...path.slice(0, path.indexOf(inside) + 1), ...rest];
      joined.push(i);
      grew = true;
    }
  }
  return { path, joined };
}

function wrap(via: number, plan: Plan): Plan {
  return { ...plan, data: { via, plan } satisfies Routed, ...(plan.undo ? { undo: wrap(via, plan.undo) } : {}) };
}
