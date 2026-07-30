# nativread-translator — modern web book translator (standalone product + validation gate + reusable core)

Status: PLAN (agent-executable)
Created: 2026-06-22 · Updated: 2026-06-22 (modern stack + deploy posture)
Parent project: NativRead (iOS EPUB reader). See `../nativread/docs/translator-plan.md`.

## Why this exists

A **standalone, modern web book translator** — good enough to stand on its own,
independent of NativRead. It does three jobs:

1. **Be a genuinely good, modern product.** Best-in-class UI, usable by a
   non-technical reader (the builder's mother). Quality of translation and of the
   experience both matter.
2. **De-risk NativRead's biggest bet.** Whether chunked AI translation produces Hungarian
   a native reader actually accepts is unvalidated. This tool answers that before any
   iOS rebuild — a HARD GATE before NativRead Phase 0.
3. **Produce a reusable translation core.** The pipeline design (chunking, markup
   preservation, glossary carry, partial-failure resume) is the port spec NativRead's
   Phase 2 follows. (Design ports, not literal code — different language.)

## Stack (decided)

- **Framework:** Next.js (App Router) + TypeScript.
- **UI:** shadcn/ui + Tailwind CSS. Optionally generate the design system / screens
  with the **Stitch MCP** (`create_design_system`, `generate_screen_from_text`), then
  implement with shadcn components.
- **Translation core:** a clean framework-agnostic TS module under `lib/core/` — server
  API routes call it; it has no Next/UI dependencies so it stays portable and unit-testable.
- **EPUB:** JS parsing (`jszip` + an XML parser, mirroring NativRead's container → OPF →
  spine flow). Honest tradeoff: JS EPUB libs are weaker than Python's `ebooklib`; we
  accept that to get shadcn-grade UI, and keep EPUB handling isolated in `lib/core/epub.ts`
  so it can be hardened independently.
- **Provider:** adapter behind a `Translator` interface. Deploy target is a private
  Proxmox homelab on the household LAN, so the default is a **shared household
  provider key in the container env** (usable by a non-technical reader — no key to
  paste). BYO-key stays supported as an option but is not required here. A `fake`
  provider drives tests with zero egress/cost.

## Legal / data posture (private household homelab)

Deploy target: a private Proxmox host on the household LAN. This is materially the
same as localhost — your own hardware, your own household, your own content — NOT a
service operated for strangers. That keeps it clean and relaxes the public-deploy
constraints:

- **Household, not public.** LAN-only, never exposed to the public internet (no port
  forwarding / public ingress). Only people on your home network reach it.
- **A persistent local library is fine here.** Translated books may be kept on your own
  Proxmox so the household doesn't re-translate — your hardware, your content. (Earlier
  "ephemeral, no storage" was a constraint for a public operated service; not needed.)
- **Shared household key** in the container env is the default (usable by a
  non-technical reader). BYO-key optional.
- **Positioning stays neutral.** What a household member uploads is their own
  responsibility; the tool is a neutral conduit.
- **Disclosure:** the UI states "Translation sends the book text to <provider>."

> Still NOT building: a public, internet-exposed, operator-paid service that stores and
> translates strangers' (likely pirated) book text. The household-LAN posture avoids
> that entirely. If this ever goes public later, revisit the stricter posture
> (BYO-key + ephemeral + access-gated + neutral).

## Non-goals

- Not an open, operator-paid public service (see legal posture).
- Not the iOS app and not a Swift project.

## Architecture

```
nativread-translator/
├── PLAN.md
├── .env.example                 (PROVIDER_API_KEY=... — shared household key; gitignored)
├── app/                         Next.js App Router
│   ├── page.tsx                 upload → progress → read/download
│   ├── api/upload/route.ts      accept EPUB (ephemeral)
│   ├── api/translate/route.ts   start/stream a job (BYO key in request, never stored)
│   ├── api/status/route.ts      job progress
│   └── api/result/route.ts      translated EPUB / reader payload
├── components/                  shadcn/ui components + app composites
│   └── ui/                      shadcn primitives
├── lib/
│   └── core/                    ← REUSABLE heart (port target for NativRead Phase 2)
│       ├── epub.ts              container/OPF/spine parse; read+write XHTML items
│       ├── chunker.ts           split spine-item XHTML into model-sized chunks
│       ├── markup.ts            tag-protection: inline tags ↔ placeholder tokens
│       ├── glossary.ts          names/terms carried across chunks
│       ├── translator.ts        Translator interface + chunk translate
│       ├── providers/{deepseek,fake}.ts
│       ├── job.ts               whole-book orchestration + per-chunk resume
│       └── cost.ts              token/cost accounting + per-book ceiling
├── lib/jobs/                    in-progress per-job state (for resume); cleared on completion
├── library/                     persisted translated books (household library; on Proxmox volume)
└── test/                        core tests, headless, fake provider
```

### Data flow

```
upload EPUB ─► epub.parse ─► spine items
   │  per item: chunker.split ─► chunks (resumable; skip completed)
   │     per chunk: markup.protect ─► translator.translate(BYO-key, glossary) ─► markup.restore
   ▼
job: re-stitch translated XHTML ─► translated EPUB ─► reader (bilingual toggle) + download
                                  └─► saved to household library (Proxmox); job state cleared
```

## Acceptance criteria (the validation gate)

- [ ] Translate a real ~80–120k-word EPUB end-to-end into Hungarian.
- [ ] Kill mid-job; restart; it **resumes** from the last completed chunk (no re-pay).
- [ ] Character/term names stay consistent across chapters (glossary).
- [ ] Inline markup (italics, dialogue, emphasis) survives (no broken tags).
- [ ] A non-technical user can upload, watch progress, and read — without help.
- [ ] Per-book cost measured and shown; hard ceiling warns before overrun.
- [ ] **Quality verdict recorded** (read with the target reader): acceptable / not, and
      failure modes (tone drift, formality te/ön, idiom, chunk-boundary sentence breaks).
- [ ] Persistent household library works: a translated book stays available so it is
      not re-translated; reachable from another household device on the LAN.

## Model and pipeline decisions (measured 2026-07-28, `bun run eval`)

Measured on *Lord of Mysteries Vol. 1* (421k words, 433 chunks), 12 sampled chunks per
config, plus Wilde's *Dorian Gray* chapter 1 read against Kosztolányi's translation.

| model | $/book | s/chunk | guard failures |
|---|---|---|---|
| **gemini-3.1-flash-lite** (chosen) | **$2.18** | **6.7** | 0/12 |
| gemini-2.5-flash (previous default) | $7.67 | 22.1 | 0/12 |
| gemini-3.5-flash-lite | $3.15 | 27.8 | 6/12 |
| gemini-3.6-flash | $15.73 | 12.6 | 0/12 |

- **Draft/refine model: `gemini-3.1-flash-lite`.** Not merely the cheapest: the only one of
  the three finalists whose output was complete and typographically consistent. 3.6-flash
  dropped an entire paragraph of dialogue and produced a bare article error ("a orgona") at
  7x the price; 2.5-flash mixed dash and quote dialogue punctuation inside one passage.
- **Escalation model: `gemini-3.6-flash`.** Its capability is worth paying for on the few
  chunks the validators flag, where its sloppiness is re-checked by the length band.
- **Thinking: `minimal`.** Gemini bills thought tokens at the output rate; measured on
  3.6-flash, one sentence spent 731 thinking tokens against 16 tokens of answer. The wire
  shape differs per model family — `bun run eval:probe` re-derives it.
- **Batch API: rejected.** It halves price and changes nothing about quality. At $2.18 and
  ~12 minutes per book it would save ~$1.09 in exchange for hours of latency, a second
  permanent code path, and the loss of per-chunk resume, ETA and pause. Revisit if the
  model tier moves up (3.6-flash batch would save $7.86/book) or volume passes ~50
  books/month.
- **Known residual:** roughly 5% of generations pick a wrong-but-plausible word ("lilac" →
  "hársfák" instead of "orgona"). It is not temperature and not the refine pass — both were
  measured. No local validator can catch this class; only a judge or a reader can.

## How an agent should execute this (subagent lanes)

Block-by-block, each block green-tested before the next.

**Block 0 (first, no parallel): contracts.** Define TS types + stubs for
`lib/core/translator.ts` (`Translator`, `TranslateChunk`), `lib/core/job.ts` (job state),
and the 4 API route request/response shapes (incl. BYO-key field). Scaffold Next.js +
shadcn (`npx shadcn@latest init`). Everything mocks these.

Then parallel:
- **Lane A — translation core** (`lib/core/*`): epub, chunker, markup, glossary, job,
  cost, fake provider. Headless, fully unit-tested. The reusable heart — highest care.
- **Lane B — API routes** (`app/api/*`): wire routes to the core job API; ephemeral
  temp state; BYO-key passed through, never persisted.
- **Lane C — UI** (`app/page.tsx`, `components/*`): shadcn upload → progress → reader →
  download, Hungarian-first, large controls, provider disclosure + BYO-key entry.
  Optionally drive the design with Stitch MCP first. Mocks the API until Lane B lands.

Then sequential:
- **Block D — real provider** (`lib/core/providers/deepseek.ts`) behind the interface.
- **Block V — verification:** real-book end-to-end + resume + ephemeral check + the
  non-technical-user walkthrough + record the quality verdict.

Lanes A/B/C own disjoint paths (`lib/core` / `app/api` / `app`+`components`) — safe to
parallelize after Block 0.

## Output back to NativRead

When the quality verdict is in, write a one-paragraph result to
`../nativread/docs/` (quality acceptable? failure modes? cost/book?) so
NativRead's Phase 0 proceeds with confidence or the direction changes. The proven
chunking/glossary/markup/resume design is the port spec for NativRead's Phase 2.

## Deployment (decided: private Proxmox homelab, household LAN)

- **Host:** a Proxmox LXC container (lighter) or VM. Node runtime; run the built
  Next.js app with `next start` (or `node` standalone output) behind a small process
  manager (systemd unit or `pm2`) so it restarts on reboot.
- **Network:** bind to the LAN; reach it from household devices via the container's
  LAN IP or a local hostname (optional reverse proxy — Caddy/nginx in the container —
  for a friendly name + LAN HTTPS). **Do NOT port-forward to the public internet.**
- **Access:** household LAN only. Optional simple auth (basic auth at the reverse
  proxy) if you want, but not required for a trusted home network.
- **Key:** shared household provider key in the container env (`.env` on the host,
  not committed). BYO-key optional.
- **Storage:** a small persistent translated-book library on the Proxmox volume is
  allowed and encouraged (so mom doesn't re-translate). Back it up with the rest of
  your Proxmox data.
- **Build/deploy loop:** `next build` → copy/standalone output to the container (or
  build in the container) → restart the service. A simple deploy script or a
  container image is enough; full CI/CD is optional for a homelab.
