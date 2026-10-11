# coreloop-engine

A local, surface-neutral voice engine. Someone says something; the engine turns it into **one safe action** on whatever they're using (a desktop, a browser, your own web app), or into a question when it isn't sure, and never into something they didn't mean.

- **Code first.** Rules, skills and parsers decide most sentences in well under a millisecond.
- **The model only picks.** When code can't decide, a small local model (decider-0.8b, 0.8B parameters) chooses among options code wrote. It never writes text that gets typed, run or sent.
- **Code checks the pick.** Thresholds, closed rules and details that must come from the user's own words.
- **Surfaces act.** A surface reports what's there, declares what it can do as plain data, and plans and runs the action. The engine knows nothing about any particular app, browser or OS.

The engine is plain TypeScript with **no dependencies**. It runs in Node (≥ 22) and in a browser, reads no files, and takes everything it needs from its host.

```text
what was said → normalise → where it goes → code first ─────────────┐
                                              └→ the model picks → policy → the conversation → a surface plans, then runs
```

Status: **0.1.0**, surface contract **v2** (protocol version 2). Apache-2.0.

---

## Install

```bash
npm install coreloop-engine
```

## A first surface, in five minutes

A surface is an object with `view()`, `plan()` and `run()`, plus its skills as data. Here is a whole one: a notes app.

```ts
import { Actor, CodeOnlyDecider, PlanError, type Decided, type Plan, type Skill, type Surface, type SurfaceView } from "coreloop-engine";

const NOTES: Skill = {
  id: "notes",
  places: ["Notes"],
  actions: [
    { id: "notes.new", label: "create a note", what: "create a new note with a title (new note called groceries)", risk: "safe",
      templates: ["[create|make|add] [a] new note (called|named) {title}"] },
    { id: "notes.delete", label: "delete a note", what: "delete a note on screen (delete the groceries note)", risk: "confirm",
      templates: ["(delete|remove) [the] {note} [note]"], slots: { note: "item" } },
  ],
};

class Notes implements Surface {
  readonly name = "notes";
  readonly skills = [NOTES];
  readonly operations: string[] = [];
  notes = [{ id: "n1", title: "Groceries" }];

  async view(): Promise<SurfaceView> {
    return {
      places: [{ name: "Notes", id: "notes" }],
      path: ["Notes"],
      open: ["Notes"],
      items: this.notes.map((n) => ({ id: n.id, label: n.title, role: "link" })),
    };
  }
  plan(a: Decided): Plan {
    if (a.operation === "notes.new") return { summary: `create "${a.slots.title}"`, detail: [], data: a };
    const note = this.notes.find((n) => n.id === a.slots.note);
    if (!note) throw new PlanError("that note isn't there any more");
    return { summary: `delete "${note.title}"`, detail: [], data: a };
  }
  async run(plan: Plan) {
    /* do what the plan says */
    return { ok: true };
  }
}

const actor = new Actor({ client: new CodeOnlyDecider(), surface: new Notes() });
await actor.handle("new note called standup");   // act: create "standup"
await actor.handle("delete the groceries note"); // confirm: waits for a spoken "confirm"
await actor.handle("confirm");                   // act: delete "Groceries", exactly as planned
```

A fuller version that also runs the conformance suite is in the repository: `examples/hello-surface.ts`.

---

## The model

The engine asks a **`Decider`**, anything that answers a request:

| | What it is |
|---|---|
| `SystemOneClient` | decider-0.8b (or any model served with the same `/v1/systemone` API) over HTTP, on the user's own machine |
| `CodeOnlyDecider` | no model: code decides what it's sure of, and everything else becomes a question |
| `FallbackDecider` | the model while it answers, code only while it's unreachable or too slow, and the model again as soon as it answers |

```ts
const client = new FallbackDecider(new SystemOneClient({ baseUrl: "http://127.0.0.1:8001", timeoutMs: 3000 }));
```

The model: [Mapika/decider-0.8b](https://huggingface.co/Mapika/decider-0.8b) (Apache-2.0, fine-tuned from Qwen3.5-0.8B-Base), served by [`decider_ai`](https://github.com/Mapika/decider) (`decider.serve`). It runs on a 6 GB laptop GPU at about 110 ms per decision.

The model's state is **only the user's words**. Window titles, page text and labels never go into it; on-screen labels reach it only as short options in a multiple-choice question. The client refuses an answer that picks something it wasn't offered.

## The surface contract (v2)

```ts
interface Place { name: string; id: string; kind?: string; aliases?: readonly string[]; generic?: readonly string[] }

interface SurfaceView {
  places: readonly Place[];   // what the user can name: apps, a web app's pages, contacts
  path?: readonly string[];   // where the user is, outermost first: ["Brave", "localhost:3000", "Pricing"]
  open: readonly string[];    // what's open, for words only an open place can mean
  items?: readonly Item[];    // the named things where the user is: links, buttons, fields
}

interface Surface {
  name: string;
  skills: readonly Skill[];             // what it can do, as plain data
  operations?: readonly string[];       // the common operations it supports (default: all)
  inside?: string;                      // the place it lives in on the surface around it ("Brave")
  view(): Promise<SurfaceView>;
  plan(action: Decided, assume?: { path?: readonly string[] }): Plan | Promise<Plan>; // throws PlanError
  run(plan: Plan): Promise<Receipt>;
  prefetch?(): void;
  afterTurn?(): void;
}
```

- **Planning changes nothing.** A destructive action is planned when it's decided and shown to the user, and the spoken "confirm" runs exactly that plan.
- **What a surface reads stays on its side.** It can be shown to the user (a receipt's notes); it never reaches the model's state.
- **Common operations** every surface may support: `open_app`, `focus_app`, `close_app`, `type_text`, `paste_text`, `press_key`, `media`, `open_url`, `search_web` (`COMMON_OPERATIONS`). The engine owns their safety and parsing rules, and never decides one a surface didn't declare.

## Skills as data

A skill is for some places and lists actions. It is plain JSON: it can travel over a connection, and `parseSkills()` checks one that arrives.

| Field | |
|---|---|
| `id`, `label` | `"notes.delete"`, `"delete a note"` |
| `what` | the option text the model reads: short, contrastive, with an example in the user's words |
| `risk` | `safe`, `fill` (types the user's words), `confirm` (always waits for a spoken "confirm"), `never` |
| `templates` | sentences that ask for it when its place is the target |
| `anywhere`, `ambient`, `afterModel` | sentences that name their own place; that only an open place can mean; used only after the model picked it |
| `slots` | the kind of each slot: `words`, `search`, `name`, `app`, `site`, `position`, `item` |
| `nouns` | what the action's things are called ("song", "artist"), for the `name` and `search` kinds |
| `byLabel` | saying an item's label on its own ("save changes") means this action on that item |
| `handles` (skill) | common operations that happen inside its place when it's named |

**Template syntax**, matched against the whole sentence: `word`, `(a|b c)` one of these, `[a|b c]` optionally one of these, `{slot}` one or more of the user's own words, `*` any words. A slot's kind can refuse the words, and then the next sentence gets a chance. No kind can produce a word the user didn't say.

## Items

Items are what's on screen where the user is: `{ id, label, role, group? }`. Code picks one by position ("the second result"), by the user's words (rare words weigh more), or by sound for names ("rahool" → Rahul). Only when that leaves no single item does the model get the `item` question, with at most 16 labels. An item whose label says buy, delete, send or submit waits for a confirm. An item with role `password` is never offered, matched or typed into.

## Several surfaces

`Surfaces` is itself a surface. It merges what several surfaces see and routes each action to the one that can carry it out.

- **Paths chain by containment:** a surface joins the path when its `inside` is on it. With the desktop `["Brave"]`, a browser inside Brave `["Brave", "localhost:3000"]` and your web app inside localhost:3000 `["Pricing"]`, the user is at `Brave › localhost:3000 › Pricing`.
- **Skills apply along the path,** inner first; for one place only its innermost skill counts.
- **Routing:** a skill action goes to the surface that declared it. A common operation for a named place goes to the innermost surface that knows that place; otherwise it goes along the path, innermost first.

## Over the wire

A surface in another process (a browser extension, a web page) serves itself to a running core over a loopback WebSocket:

```ts
const conn = await serveSurface(mySurface, { url: "ws://127.0.0.1:7777", token, inside: "Brave" });
```

The protocol (`PROTOCOL_VERSION` 2) is `hello` / `welcome` / `call` / `result` messages, with a per-launch token on every message both ways. Everything a surface sends is validated (`parseView`, `parsePlan`, `parseSkills`) before the engine uses it. The core's server is part of the host, not this package: in the coreloop repository it is `npm run core`, which listens on loopback only and checks Host and Origin.

## A person's profile

`useProfile(profile)` hands the engine a person's data:
- mishearings (`aliases`), with first-word slips (`starts`);
- their own sentences (`phrases`, each meaning another command, which still passes every rule);
- nicknames for places;
- sites they name without a domain;
- words they add after dictation;
- actions turned off.

None of it can touch safety: confirm and cancel can't be turned off, and a phrase is only a rewrite. Without a profile the engine runs with `EMPTY_PROFILE`.

## Safety, by construction

- Destructive actions (`risk: "confirm"`, close verbs, destructive labels, "… and send") always wait for a spoken "confirm", which runs the exact plan that was shown.
- Text that gets typed or pasted is always a span of the user's own words; URLs, numbers and keys come from parsers.
- The model never sees page, window or app text in its state, and its picks are checked by code.
- Password fields are never voice-accessible.
- An operation a surface didn't declare is never decided.

## Seeing what it did

```ts
const { value, steps } = await traced(() => actor.handle("open the settings page"));
// steps: [{ stage: "normalise", id: "normalise.clean", note: "...", data: {...}, t: 0.4 }, ...]
```

Every decision point records a step: its stage, a stable id (the same string is at the call in the source), what it decided and why. Tracing is off unless asked for and never changes a decision.

## Checking a surface

```ts
for (const c of await conformance(mySurface, { samples })) console.log(c.ok ? "✔" : "✖", c.name, c.detail ?? "");
```

It checks that the skills are valid data, that the view has the contract's shape, that planning changes nothing, that plans are JSON and say what they'll do, and that an unknown action is refused with a `PlanError`.

## API

| Area | Exports |
|---|---|
| The loop | `Actor`, `understand`, `understandByCode`, `Session`, `whatICanDo`, `normalise`, `THRESHOLDS` |
| The model | `SystemOneClient`, `SystemOneError`, `CodeOnlyDecider`, `FallbackDecider`, `buildRequest`, `Decider`, `Decision` |
| Surfaces | `Surface`, `SurfaceView`, `Place`, `Plan`, `Receipt`, `Decided`, `Assume`, `PlanError`, `Surfaces`, `chain` |
| The wire | `serveSurface`, `PROTOCOL_VERSION`, `parseHello`, `parseView`, `parsePlan`, `parseReceipt`, `parseMessage`, `ProtocolError` |
| Skills | `Skill`, `SkillAction`, `SkillSet`, `parseSkills`, `SkillError`, `SLOT_KINDS`, `COMMON_OPERATIONS`, `ALL_COMMON` |
| Profile | `useProfile`, `currentProfile`, `checkProfile`, `EMPTY_PROFILE`, `ProfileError`, `Profile` |
| Checking | `conformance`, `defaultSamples`, `traced`, `tracing` |

## Versioning

Semver. Within 0.x a minor version may change the API; the surface contract and the wire protocol carry their own version (`PROTOCOL_VERSION`), and a surface built for v2 keeps working until a v3 is announced.

## License

Apache-2.0. See `LICENSE` and `NOTICE`. The decision model and its server are separate projects under their own Apache-2.0 licences.
