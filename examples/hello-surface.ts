/**
 * A first surface for coreloop-engine: a tiny notes app, in about a hundred lines.
 *
 *   npm run build:engine && npm run example
 *
 * A surface tells the engine what's there (view), what it can do (skills, as plain data), and turns a decided
 * action into exact steps (plan) that it then carries out (run). Everything else (understanding the words, the
 * model, confirms, questions, repairs) is the engine's.
 */
import { Actor, CodeOnlyDecider, conformance, PlanError, type Decided, type Plan, type Receipt, type Skill, type Surface, type SurfaceView } from "coreloop-engine";

interface Note {
  id: string;
  title: string;
}

/** What the notes app can do, as data. The engine matches the templates; the model only ever picks an action id. */
const NOTES: Skill = {
  id: "notes",
  places: ["Notes"],
  actions: [
    {
      id: "notes.new",
      label: "create a note",
      what: "create a new note with a title (new note called groceries)",
      risk: "safe",
      templates: ["[create|make|add|start] [a] new note (called|named|titled) {title}", "new note {title}"],
    },
    {
      id: "notes.open",
      label: "open a note",
      what: "open one of the notes on screen (open the groceries note)",
      risk: "safe",
      templates: ["(open|show|show me) [the] {note} [note]", "(open|show) [the] (first|second|third|last) note"],
      slots: { note: "item" },
      byLabel: true,
    },
    {
      id: "notes.delete",
      label: "delete a note",
      what: "delete one of the notes on screen (delete the groceries note)",
      // destructive: the engine holds it for a spoken "confirm", always
      risk: "confirm",
      templates: ["(delete|remove|trash) [the] {note} [note]"],
      slots: { note: "item" },
    },
  ],
};

class NotesSurface implements Surface {
  readonly name = "notes";
  readonly skills = [NOTES];
  /** No common operations of its own (no apps to open, no web to search): only its skill's actions. */
  readonly operations: string[] = [];
  notes: Note[] = [
    { id: "n1", title: "Groceries" },
    { id: "n2", title: "Trip to Lisbon" },
  ];
  open: string | undefined;

  async view(): Promise<SurfaceView> {
    return {
      places: [{ name: "Notes", id: "notes", kind: "app" }],
      path: ["Notes"],
      open: ["Notes"],
      // the things on screen, as items: labels are untrusted text the engine matches by code
      items: this.notes.map((n) => ({ id: n.id, label: n.title, role: "link", group: "note" })),
    };
  }

  /** The exact steps, without doing anything: a confirm shows these, and "confirm" runs exactly them. */
  plan(action: Decided): Plan {
    const { operation, slots } = action;
    const note = this.notes.find((n) => n.id === slots.note);
    switch (operation) {
      case "notes.new":
        return { summary: `create the note "${String(slots.title)}"`, detail: [`new note "${String(slots.title)}"`], data: { do: "new", title: slots.title } };
      case "notes.open":
        if (!note) throw new PlanError("that note isn't there any more");
        return { summary: `open "${note.title}"`, detail: [`open ${note.id}`], data: { do: "open", id: note.id } };
      case "notes.delete":
        if (!note) throw new PlanError("that note isn't there any more");
        return { summary: `delete "${note.title}"`, detail: [`delete ${note.id}`], data: { do: "delete", id: note.id } };
      default:
        throw new PlanError(`notes can't ${operation}`);
    }
  }

  async run(plan: Plan): Promise<Receipt> {
    const step = plan.data as { do: string; id?: string; title?: string };
    if (step.do === "new") this.notes.push({ id: `n${this.notes.length + 1}`, title: String(step.title) });
    if (step.do === "open") this.open = step.id;
    if (step.do === "delete") this.notes = this.notes.filter((n) => n.id !== step.id);
    return { ok: true };
  }
}

// 1. Does the surface keep the contract? (in-process here; serveSurface() runs the same over the WebSocket)
const surface = new NotesSurface();
// every action here takes words, so it says what to plan (and nothing runs: planning only)
const samples: Decided[] = [
  { decision: "act", operation: "notes.new", slots: { title: "conformance test" }, reason: "sample" },
  { decision: "act", operation: "notes.open", slots: { note: "n1" }, reason: "sample" },
];
for (const c of await conformance(surface, { samples })) console.log(`${c.ok ? "✔" : "✖"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);

// 2. Talk to it. No model needed for these: code decides them (FallbackDecider + SystemOneClient adds the model).
const actor = new Actor({ client: new CodeOnlyDecider(), surface });
for (const said of ["new note called standup notes", "open the lisbon note", "delete groceries", "confirm", "what's the weather"]) {
  const r = await actor.handle(said);
  const o = r.outcome;
  const what = r.plan?.summary ?? (o.decision === "ask" ? (o.hint ?? o.reason) : o.reason);
  console.log(`“${said}” → ${o.decision}${r.pending ? " (waiting for “confirm”)" : ""}: ${what}`);
}
console.log("notes now:", surface.notes.map((n) => n.title).join(", "));
