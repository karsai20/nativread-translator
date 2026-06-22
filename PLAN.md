# quire-translator — local web book translator (validation tool + reusable core)

Status: PLAN (agent-executable)
Created: 2026-06-22
Parent project: Quire (iOS EPUB reader). See `~/.gstack/projects/karsai20-quire/karsai-main-design-20260622-122533.md`.

## Why this exists (read first)

This is a **standalone, localhost-only web book translator**. It is NOT the iOS app.
It exists to do three jobs at once, in order of importance:

1. **De-risk the iOS app's biggest bet.** Quire's flagship is AI-translating books
   into Hungarian. Whether chunked AI translation produces Hungarian a non-technical
   native reader will actually read is **unvalidated and the highest-uncertainty part
   of the whole product.** This tool answers that question in one evening, before any
   iOS rebuild starts. It is a HARD GATE before Quire Phase 0.
2. **Be genuinely usable by a non-technical reader (the builder's mother).** It runs
   on localhost, no deploy, no account, no security risk. She uploads a book, gets it
   in Hungarian, reads it. This is the truest quality signal.
3. **Produce a reusable translation core.** The translation pipeline (chunking,
   markup preservation, glossary carry, partial-failure resume, provider adapter) is
   built here as a clean module. Quire's Phase 2 ports it to Swift from a **proven
   design** instead of inventing it in-app.

## Non-goals

- Not a deployed/hosted service. Localhost only (binds `127.0.0.1`).
- Not a product to sell. Personal/circle validation tool.
- Not the iOS app and not a Swift project. (The *design* is what ports, not the code.)

## Legal / data posture (dumb-pipe — inherited from the Quire design)

- The **user** supplies their own EPUB and **initiates** translation. The tool is a
  neutral conduit; it never stores or redistributes translated books beyond the
  user's own local machine.
- The only network egress is the **user-initiated** provider call (text → provider).
  Disclose this in the UI: "Translation sends the book text to <provider>."
- Positioning stays neutral. Never frame it as "translate pirated books."
- Provider API key lives in a local `.env`, never committed.

## Stack (decided)

- **Runtime:** Bun + TypeScript (Bun 1.3.x already installed). Single runtime for
  server, build, and tests. Dependency-light.
- **Server:** Bun's built-in HTTP server. Binds `127.0.0.1:<port>` only.
- **Frontend:** Plain TypeScript + minimal HTML/CSS, served static. No heavy
  framework. Hungarian-first UI, large controls, usable by a non-technical reader.
- **EPUB:** parse with a small zip lib + XML parsing (mirror Quire's container → OPF
  → spine flow so the design transfers).
- **Provider:** DeepSeek API adapter behind a `Translator` interface, so the provider
  is swappable (and a fake provider drives tests with zero API cost).

## Architecture

```
quire-translator/
├── PLAN.md                      (this file)
├── .env.example                 (PROVIDER_API_KEY=...)
├── src/
│   ├── core/                    ← the REUSABLE heart (port target for Swift)
│   │   ├── epub.ts              parse container/OPF/spine; read+write XHTML items
│   │   ├── chunker.ts           split spine-item XHTML into model-sized chunks
│   │   ├── markup.ts            tag-protection: swap inline tags ↔ placeholder tokens
│   │   ├── glossary.ts          names/terms carried across chunks for consistency
│   │   ├── translator.ts        Translator interface + chunk→chunk translate
│   │   ├── providers/
│   │   │   ├── deepseek.ts       real provider adapter
│   │   │   └── fake.ts           deterministic fake for tests (no egress, no cost)
│   │   ├── job.ts               orchestrates a whole-book job: chunk → translate →
│   │   │                        re-stitch XHTML → write EPUB; persists per-chunk
│   │   │                        progress so a killed job RESUMES (not restarts)
│   │   └── cost.ts              token/cost accounting + a hard per-book ceiling
│   ├── server/
│   │   ├── index.ts             Bun HTTP server, 127.0.0.1 only
│   │   └── routes.ts            POST /upload, POST /translate, GET /status, GET /result
│   └── web/
│       ├── index.html           upload → progress → read/download
│       ├── app.ts               talks to the API; renders progress + reader
│       └── style.css            clean, large, Hungarian-first
├── jobs/                        per-job state on disk (resume); gitignored
└── test/                        core tests run headless against the fake provider
```

### Data flow

```
EPUB upload
   │
   ▼
epub.parse ──► spine items (XHTML)
   │
   ▼  per spine item
chunker.split ──► chunks (≤ model token budget)
   │
   ▼  per chunk (resumable: skip chunks already in jobs/<id>/)
markup.protect ─► translator.translate(provider, glossary) ─► markup.restore
   │
   ▼
job: re-stitch translated XHTML into spine item ─► write translated EPUB
   │
   ▼
GET /result ──► in-browser reader (optional bilingual toggle) + download
```

## Acceptance criteria (this is the validation gate)

- [ ] Translate a real ~80–120k-word EPUB end-to-end into Hungarian.
- [ ] Kill the process mid-job; restart; it **resumes** from the last completed
      chunk (does not re-translate or re-pay for finished chunks).
- [ ] Character/term names stay consistent across chapters (glossary works).
- [ ] Inline markup (italics, dialogue, emphasis) survives translation (no broken
      tags in the output EPUB).
- [ ] A non-technical user can: open localhost, upload, wait with visible progress,
      and read the result — without help.
- [ ] Per-book cost is measured and shown; a hard ceiling warns before overrun.
- [ ] **Quality verdict recorded:** read the result with the target reader (mom).
      Capture a short note: acceptable / not acceptable, and the specific failure
      modes if not (tone drift, formality te/ön, idiom, sentence breaks at chunk
      boundaries). This verdict is the gate output for Quire Phase 0.

## How an agent should execute this (subagent lanes)

Build block-by-block; each block ships with green tests before the next. Lanes A–C
are largely parallel once the interfaces below are fixed first.

**Block 0 (do first, no parallel): fix interfaces.** Define the TypeScript types and
function signatures for `core/translator.ts` (`Translator`, `TranslateChunk`),
`core/job.ts` (job state shape), and the HTTP API contract (the 4 routes' request/
response JSON). Write these as types + stubs. Everything else mocks against them.

Then dispatch in parallel:
- **Lane A — translation core** (`src/core/*`): epub, chunker, markup, glossary,
  job, cost, fake provider. Fully testable headless against `providers/fake.ts`.
  This is the reusable heart — highest care. Owns: `src/core/`.
- **Lane B — server** (`src/server/*`): wire the 4 routes to the core's job API;
  persist job state under `jobs/`; bind 127.0.0.1 only. Owns: `src/server/`.
- **Lane C — web UI** (`src/web/*`): upload, live progress, in-browser reader +
  download, Hungarian-first, large controls, third-party-send disclosure. Mocks the
  API contract until Lane B lands. Owns: `src/web/`.

Then sequential:
- **Block D — real provider:** implement `providers/deepseek.ts` behind the
  `Translator` interface; key from `.env`. Swap in for the fake.
- **Block V — verification ("does it assemble"):** end-to-end run on a real book +
  resume test + the non-technical-user walkthrough + record the quality verdict.

Conflict note: Lanes A/B/C own disjoint directories — safe to parallelize. Block 0
(interfaces) must complete before A/B/C start, and Block D/V after.

## Output back to Quire

When the quality verdict is in, write a one-paragraph result to
`~/.gstack/projects/karsai20-quire/` (translation quality: acceptable? failure modes?
cost per book?) so Quire's Phase 0 either proceeds with confidence or the product
direction changes. The proven chunking/glossary/markup/resume design is the port
spec for Quire's Phase 2 translation pipeline.
