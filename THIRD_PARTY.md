# Third-party work in coreloop

coreloop's own code is in this repo. What came from elsewhere, and under which terms:

## Ported or adapted

### jev-voice-browser

- **Source:** `jev-voice-browser` (https://github.com/moritzkremb/jev-voice-browser), the browser voice-control prototype this project grew from.
- **What was ported:**
  - **The 34 browser test cases** (`eval/browser.json`), adapted to coreloop's conversation format.
  - **Page snapshots:** Hacker News, two Wikipedia pages, example.com, and the search-results, checkout and product pages (`eval/browser/pages.json`).
  - **Choosing among page items:**
    - the 16-option cut;
    - the gates 0.45 / 0.35 / 0.08;
    - the destructive-label pattern;
    - "the other one" and undo-as-going-back (`src/core/items.ts`, `src/core/repair.ts`).
  - **The Host and Origin checks** for the local server (`src/host/server.ts`).
- **License:** MIT.

```
MIT License

Copyright (c) 2026 Moritz Kremb

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Test pages

`eval/browser/pages.json` holds page snapshots for the simulated browser.

- **Synthetic**: six pages first captured from public sites on 2026-10-04 now hold invented content in the same structure:
  - `github-repo` and `github-issues`: a fictional "Lumen" framework by "acme-labs";
  - `ddg-lumen`: search results;
  - `docs-array-map`: a reference page on a fictional docs site;
  - `npm-lumen`: a package page;
  - `youtube-lofi`: video results.

  The sites' interface labels ("Sign in", "Issues", "Readme") and API names (`filter()`) remain. Every commit message, issue title, result, snippet, video and channel name is invented.
- **Written for coreloop:** the three `localhost-*` pages (a fictional "Acme" app).
- **From the prototype** (MIT, above): `search-results`, `checkout`, `product`, `example`.
- **Synthetic too** (2026-10-05): the prototype's Hacker News and Wikipedia snapshots.
  - `news` is "Orbit News" on news.example.com, with invented stories, sites and users.
  - `wiki-main` and `wiki-article` are "Openpedia" on wiki.example.org: a fictional front page, and an article about a fictional computing pioneer.
  - The structure and the interface words remain (header links, "N comments", section headings, citations); all titles, names and link texts are invented.

## Algorithms

- **Metaphone:** `src/core/phonetic.ts` is a simplified Metaphone (Lawrence Philips, 1990), written from the published description.

## Dependencies and models (not in this repo; installed separately)

| Dependency | Where it's used | License |
|---|---|---|
| `ws` | the WebSocket server | MIT |
| `sherpa-onnx-node` | speech-to-text runtime | Apache-2.0 |
| `uiohook-napi` | the global push-to-talk key | MIT |
| Parakeet TDT 0.6B v2 (NVIDIA) | speech-to-text model | CC-BY-4.0 (checked on its model page, 2026-10-11) |
| Silero VAD (Silero Team, https://github.com/snakers4/silero-vad) | trims silence before speech-to-text | MIT, "Copyright (c) 2020-present Silero Team" (checked in its LICENSE, 2026-10-11) |
| decider-0.8b (Mapika, https://huggingface.co/Mapika/decider-0.8b) | the decision model | Apache-2.0, fine-tuned from Qwen/Qwen3.5-0.8B-Base (Apache-2.0). Checked 2026-10-05 in the downloaded model's README and on its model page |
| `decider_ai` 1.8.1 (`decider.serve`, Mark Marosi, https://github.com/Mapika/decider) | serves the model | Apache-2.0 (its package metadata) |
