# coreloop

A local, surface-neutral voice engine. Someone says something, and coreloop turns it into **one safe action** on whatever they're using (a desktop, a browser, your own web app), or into a question when it isn't sure. It never does something they didn't mean.

**[Documentation](https://coreloop-doc.vercel.app)** · **[npm: coreloop-engine](https://www.npmjs.com/package/coreloop-engine)** · [Quick start](https://coreloop-doc.vercel.app/docs/get-started/quick-start) · [The book](https://coreloop-doc.vercel.app/book/the-loop) · [Playground](https://coreloop-doc.vercel.app/playground) · [Benchmarks](https://coreloop-doc.vercel.app/benchmarks)

```text
what was said → normalise → where it goes → code first ─────────────┐
                                              └→ the model picks → policy → the conversation → a surface plans, then runs
```

- **Code first.** Rules, skills and parsers decide most sentences in well under a millisecond.
- **The model only picks.** When code can't decide, a small local model (decider-0.8b) chooses among options code wrote. It never writes text that gets typed, run or sent.
- **Code checks the pick.** Thresholds, closed rules, and details that must come from the user's own words.
- **Destructive actions wait.** Closing, deleting, sending and buying are planned, shown, and held until the user says "confirm", with or without the model.
- **Surfaces act.** A surface reports what's there, declares what it can do as plain data, and plans and runs the action. The engine knows nothing about any particular app, browser or OS.
- **Everything is local.** No account, no cloud. The model runs on your GPU, and speech-to-text on your CPU.

## Use the package

```bash
npm install coreloop-engine
```

Plain TypeScript with no dependencies. It runs in Node 22 or newer and in a browser.

```ts
import { Actor, CodeOnlyDecider } from "coreloop-engine";

const actor = new Actor({ client: new CodeOnlyDecider(), surface: new NotesSurface() });

const r = await actor.handle("delete the groceries note");
console.log(r.outcome.decision, r.pending?.summary); // confirm delete "Groceries"
await actor.handle("confirm"); // runs exactly the plan that was shown
```

`NotesSurface` is built in [Your first surface](https://coreloop-doc.vercel.app/docs/get-started/first-surface), about a hundred lines. [Use the npm package](https://coreloop-doc.vercel.app/docs/get-started/npm-package) adds the model, a surface in another process, and a person's profile.

## Run it from source

You need Node 24 or newer and Git.

```bash
git clone https://github.com/Ayuxh-Pratap/coreloop.git
cd coreloop
npm install
npm run repl -- --no-model
```

The REPL runs the real engine on a simulated desktop, so nothing on your machine changes. Try `open spotify`, `close spotify`, then `confirm`.

**With the model and your voice** (Windows with an NVIDIA GPU, 6 GB is enough, plus [uv](https://docs.astral.sh/uv/) and ffmpeg). decider-0.8b uses about 2.7 GB of VRAM and around 110 ms per decision. Everything else runs without it.

```bash
npm run models:setup     # once: Python, the model and speech-to-text, inside the repository
npm run models:start     # decider-0.8b on 127.0.0.1:8001
npm run repl             # type sentences
npm run live             # hold Right Ctrl, speak, release
```

[Commands](https://coreloop-doc.vercel.app/docs/reference/commands) lists every script and its options.

## What's here

| | |
| --- | --- |
| `src/core`, `src/skills`, `src/surface`, `src/live`, `src/backends` | the engine: the loop, the policy, skills as data, the surface contract, the wire protocol, the actor and the deciders |
| `packages/engine` | the `coreloop-engine` package, built from the engine's files (`src/index.ts` is its API) |
| `src/sim` | the simulated desktop and browser the engine is tested on |
| `src/host`, `src/audio`, `src/cli` | the host around the engine: the core's server, the profile files, the microphone and speech-to-text, and the commands |
| `src/eval`, `src/journal`, `src/review` | scoring the evals, the journal of real use, and turning its mistakes into proposed profile changes |
| `eval` | the eval sets (desktop, daily use, workflows, browser, nested surfaces) and the fixture profile they run on |
| `examples/hello-surface.ts` | a whole surface on the built package |
| `docs/pipeline-map.html` | the pipeline map: how a sentence flows through every file, with recorded runs (`npm run map`) |

## Check a change

```bash
npm test
npm run typecheck
npm run eval -- daily --no-model
npm run check:package
```

The tests and evals run on fixtures in the repository, so everyone gets the same numbers. [Contributing](https://coreloop-doc.vercel.app/docs/project/contributing) has the rules every change keeps.

## Licence

Apache-2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE). The model and other work coreloop builds on are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
