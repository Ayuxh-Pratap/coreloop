import { describe, expect, it } from "vitest";
import type { ChoiceAnswer, SystemOneClient } from "../src/backends/systemone.ts";
import { endsWithLabel, itemPickOk, looksDestructive, matchItem, MAX_OPTIONS, pickOptions, type Item } from "../src/core/items.ts";
import { normalise } from "../src/core/normalise.ts";
import { decide } from "../src/core/policy.ts";
import { buildRequest } from "../src/core/questions.ts";
import { parseRepair } from "../src/core/repair.ts";
import { Actor } from "../src/live/actor.ts";
import { SimBrowser } from "../src/sim/browser.ts";
import { loadPages } from "../src/sim/fixture.ts";
import { SkillSet } from "../src/skills/skillset.ts";

const pages = loadPages();
const results = pages["search-results"]!.items;
const hn = pages.news!.items;

const noModel = {
  decide: () => {
    throw new Error("model called");
  },
} as unknown as SystemOneClient;

const choice = (ranked: [string, number][]): ChoiceAnswer => {
  const k = ranked.length;
  const top = ranked[0]![1];
  return {
    type: "choice",
    choice: ranked[0]![0],
    confidence: (top - 1 / k) / (1 - 1 / k),
    probabilities: Object.fromEntries(ranked),
    ranked: ranked.map(([option, p]) => ({ option, p })),
  };
};

describe("matching an item by code", () => {
  it("counts a position within a group", () => {
    expect(matchItem("the first result", results)?.id).toBe("e20");
    expect(matchItem("the second result", results)?.id).toBe("e21");
    expect(matchItem("the last result", results)?.id).toBe("e26");
    expect(matchItem("the first result", results, ["e20"])?.id).toBe("e21");
  });

  it("picks the one label that has the words, and leaves a tie to the model", () => {
    expect(matchItem("the documentation", pages.product!.items)?.id).toBe("e03");
    expect(matchItem("new", hn)?.id).toBe("e03"); // the exact label wins over others that have "new" too
    expect(matchItem("the github link", results)).toBeUndefined(); // "GitHub - …" and "github.com"
  });

  it("narrows by the kind of thing named", () => {
    expect(matchItem("the search box", pages["wiki-main"]!.items)?.id).toBe("e02"); // not the Search button
    expect(matchItem("the email field", pages.checkout!.items)?.id).toBe("e02");
  });

  it("never takes spoken URL parts as names", () => {
    expect(matchItem("example dot com", hn)).toBeUndefined();
  });

  it("matches misheard names in a contact list by sound", () => {
    const contacts: Item[] = [
      { id: "c1", label: "Rahul", role: "contact" },
      { id: "c2", label: "Sam Carter", role: "contact" },
      { id: "c3", label: "Dev Team", role: "contact" },
    ];
    expect(matchItem("rahool", contacts)?.id).toBe("c1");
    expect(matchItem("raahul", contacts)?.id).toBe("c1");
    expect(matchItem("sam karter", contacts)?.id).toBe("c2");
    expect(matchItem("dev teem", contacts)?.id).toBe("c3");
    expect(matchItem("lunch", contacts)).toBeUndefined();
    expect(matchItem("the docs", hn)).toBeUndefined(); // not "discuss"
  });
});

describe("items for the model", () => {
  it("offers at most 16, those sharing a word first, in screen order", () => {
    const picked = pickOptions(hn, "the comments");
    expect(picked).toHaveLength(MAX_OPTIONS);
    const order = picked.map((i) => hn.indexOf(i));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(picked.filter((i) => /comments/.test(i.label)).length).toBe(MAX_OPTIONS);
  });

  it("asks the item question with the labels as options only, never in the state", () => {
    const req = buildRequest("click the github link", { items: pickOptions(results, "click the github link") });
    expect(req.state).toEqual({ transcript: "click the github link" });
    expect(req.questions.item?.criteria).toMatchObject({ e24: expect.stringContaining('link "GitHub'), none: expect.any(String) });
  });

  it("acts on the model's pick only when it is confident and the words point at it", () => {
    const e24 = results.find((i) => i.id === "e24")!;
    expect(itemPickOk(e24, "the github link", 0.6, 0.6)).toBe(true);
    expect(itemPickOk(e24, "the github link", 0.3, 0.6)).toBe(false);
    expect(itemPickOk(e24, "the pricing page", 0.9, 0.9)).toBe(false);
    expect(itemPickOk(e24, "the fifth result", 0.9, 0.9)).toBe(true);
  });

  it("asks which one, by number, when the model isn't sure", () => {
    const sim = new SimBrowser(pages, "search-results");
    const skills = new SkillSet(sim.skills, sim.operations);
    const answers = {
      operation: choice([["page.click", 0.9], ["none", 0.1]]),
      item: choice([["e24", 0.4], ["e25", 0.38], ["e20", 0.12], ["none", 0.1]]),
    };
    const o = decide(normalise("click the github link"), answers, { apps: [], skills, front: "Browser", target: { app: "Browser", via: "front" }, items: results });
    expect(o.decision).toBe("ask");
    expect(o.decision === "ask" && o.choices?.map((c) => c.slots.item)).toEqual(["e24", "e25", "e20"]);
  });
});

describe("safety", () => {
  it("holds a destructive label for a spoken confirm", () => {
    expect(looksDestructive("Place order")).toBe(true);
    expect(looksDestructive("Delete account")).toBe(true);
    expect(looksDestructive("Read the docs")).toBe(false);
  });

  it("doesn't wait for more words when the sentence ends with a label on the screen", () => {
    expect(endsWithLabel("click log in", pages["wiki-main"]!.items)).toBe(true);
    expect(endsWithLabel("click sign in", pages.example!.items)).toBe(false);
  });
});

describe("repairs among items", () => {
  it("reads 'the other one' and the undo phrases", () => {
    expect(parseRepair("no the other one", [], false)).toEqual({ kind: "other" });
    expect(parseRepair("the other link", [], false)).toEqual({ kind: "other" });
    expect(parseRepair("no not that one", [], false)).toEqual({ kind: "undo" });
    expect(parseRepair("wrong link undo that", [], false)).toEqual({ kind: "undo" });
  });
});

describe("the simulated browser", () => {
  it("clicks by position, goes where the link goes, and undoes by going back", async () => {
    const sim = new SimBrowser(pages, "search-results");
    const actor = new Actor({ client: noModel, surface: sim });
    const r = await actor.handle("click the first result");
    expect(r.outcome.decision === "act" && r.outcome.slots.item).toBe("e20");
    expect(sim.page.url).toBe("https://typesafe.ai/jev");
    await actor.handle("no not that one");
    expect(sim.page.url).toBe(pages["search-results"]!.url);
  });

  it("'the other one' goes back and picks again without the first pick", async () => {
    const sim = new SimBrowser(pages, "search-results");
    const actor = new Actor({ client: noModel, surface: sim });
    await actor.handle("click the first result");
    const r = await actor.handle("no, the other one");
    expect(r.repair?.kind).toBe("other");
    expect(r.outcome.decision === "act" && r.outcome.slots.item).toBe("e21");
    expect(sim.log.map((s) => s.do)).toEqual(["click", "back", "click"]);
    const again = await actor.handle("the other one");
    expect(again.outcome.decision === "act" && again.outcome.slots.item).toBe("e22");
  });

  it("holds 'click place order' for a confirm, and clicks 'log in' without waiting", async () => {
    const checkout = new SimBrowser(pages, "checkout");
    const r = await new Actor({ client: noModel, surface: checkout }).handle("click place order");
    expect(r.pending?.summary).toBe('click "Place order"');
    expect(checkout.log).toEqual([]);
    const wiki = new SimBrowser(pages, "wiki-main");
    const login = await new Actor({ client: noModel, surface: wiki }).handle("click log in");
    expect(login.outcome.decision === "act" && login.outcome.slots.item).toBe("e06");
  });

  it("searches in the page's own search box when it has one, else on the web", async () => {
    const wiki = new SimBrowser(pages, "wiki-main");
    await new Actor({ client: noModel, surface: wiki }).handle("search for mira castell");
    expect(wiki.log[0]).toEqual({ do: "type", item: "e02", text: "mira castell", submit: true });
    const ex = new SimBrowser(pages, "example");
    await new Actor({ client: noModel, surface: ex }).handle("search for jev typesafe");
    expect(ex.log[0]).toEqual({ do: "navigate", url: "https://duckduckgo.com/?q=jev%20typesafe" });
  });

  it("types the user's own words into the field they named", async () => {
    const sim = new SimBrowser(pages, "checkout");
    await new Actor({ client: noModel, surface: sim }).handle("type bob at example dot com in the email field");
    expect(sim.log).toEqual([{ do: "type", item: "e02", text: "bob at example dot com" }]);
  });

  // a skill's typing can't submit, so "… and send" is asked about, never dropped
  it("asks about 'type … into the card number and send' instead of dropping 'and send'", async () => {
    const sim = new SimBrowser(pages, "checkout");
    const r = await new Actor({ client: noModel, surface: sim }).handle("type hello into the card number and send");
    expect(r.outcome).toMatchObject({ decision: "ask", reason: `page.type_into can't "and send"` });
    expect(sim.log).toEqual([]);
    const plain = await new Actor({ client: noModel, surface: sim }).handle("type hello into the card number");
    expect(plain.outcome.decision).toBe("act");
  });
});

describe("positions in the surface's own groups", () => {
  const tasks: Item[] = [
    { id: "t1", label: "Buy milk", role: "listitem", group: "task" },
    { id: "t2", label: "Call the bank", role: "listitem", group: "task" },
  ];
  it("counts 'the first task' and 'the last task' in the task group", () => {
    expect(matchItem("the first task", tasks)?.id).toBe("t1");
    expect(matchItem("the last task", tasks)?.id).toBe("t2");
    expect(matchItem("the second tasks", tasks)?.id).toBe("t2");
  });
  it("still needs a group or a known noun", () => {
    expect(matchItem("the first thing", tasks)).toBeUndefined();
  });
});

describe("labels that name a page, not the act", () => {
  it.each(["Order history", "Payment methods", "Order status", "Track my order", "Post settings"])("%s doesn't wait for a confirm", (label) => {
    expect(looksDestructive(label)).toBe(false);
  });
  it.each(["Place order", "Delete order history", "Pay now", "Send", "Sign out", "Order now", "Submit payment"])("%s still does", (label) => {
    expect(looksDestructive(label)).toBe(true);
  });
});
