# Translation pipeline redesign — precise + fast, DeepSeek-only

**Date:** 2026-06-24
**Status:** Approved design (pre-implementation)
**Component:** nativread-translator translation engine (`lib/core`, `lib/server`)

## Goal

Make book translation as **precise** (balanced fidelity + literary naturalness, with
error-catching) and as **fast** as possible within DeepSeek, using established MT
techniques (TEaR-style selective refinement, quality-estimation gating, local QE
validators) and production API-call standards (retry/backoff, timeouts, adaptive
concurrency, structured outputs).

This is an **evolution** of the current engine, not a rewrite. The parallel chunk pool,
chunker, glossary, shared style anchor, cost accounting, ETA, and resume model all stay.

## Constraints (decided during brainstorming)

- **Provider:** DeepSeek only — `deepseek-v4-flash` for translate/draft/refine,
  `deepseek-reasoner` for the hardest chunks. No local model, no second provider.
  The single shared household DeepSeek key remains the norm (no per-user keys).
- **Precision meaning:** "balanced" by default — accurate meaning AND natural Hungarian,
  with verification that nothing is dropped/distorted. Per-book configurable.
- **Verification appetite:** adaptive — free local checks + the existing 1–5 self-judge
  on every chunk; an extra API call (accuracy / back-translation) only on suspicious
  chunks.
- **Architecture choice:** Approach A — adaptive, gated single-pass pipeline (effort
  routing), not a two-pass review-everything design.

## Non-goals (YAGNI)

- No second provider, no COMET/embeddings, no local models.
- No per-book precision UI toggle in this iteration (engine + env default + job field
  only; UI can come later).
- No back-translation of every chunk (only flagged chunks, and only in fidelity mode).
- No change to the EPUB parsing, chunking sizes, or library/reader surfaces.

## Architecture — three layers

```
1) Transport layer        NEW: lib/core/providers/http.ts
   fetchWithRetry: retry + backoff + jitter, per-request timeout (AbortController),
   Retry-After handling, structured-output (json_object) helper. Provider-agnostic.
        ▲
2) Quality pipeline       NEW dir: lib/core/quality/*  (extracted from translator.ts)
   Per-chunk effort routing: draft → local validators → self-judge → gated
   refine/escalation. Small, pure, independently testable units.
        ▲
3) Orchestration          EXISTING: lib/core/job.ts parallel chunk pool, chunker,
   glossary, style anchor, cost.ts, eta.ts, resume — structurally unchanged.
```

Each layer is testable in isolation: transport with an injected `fetch`, validators as
pure functions, routing with a spy provider, orchestration with the FakeTranslator.

## Layer 1 — Transport (`lib/core/providers/http.ts`)

A single `fetchWithRetry(url, init, opts)` used by every DeepSeek call.

- **Retryable:** HTTP `429`, `500`, `502`, `503`, `504`, and network/timeout errors.
- **Non-retryable (fail fast, clear message):** `400`, `401`, `403` — config/key errors.
- **Backoff:** exponential, base ~1s, factor 2, cap ~30s, max ~5 attempts, full jitter.
  If a `429`/`503` carries `Retry-After`, honor it instead of the computed delay.
- **Timeout:** `AbortController` per request. Default ~120s; longer for reasoner calls.
  A hung request aborts and is retried (counts as an attempt).
- **Backpressure (AIMD-lite):** a shared controller tracks recent `429`s. On a sustained
  burst it imposes a short global cooldown before new requests dispatch, then relaxes.
  Per-request backoff is the primary mechanism; this just prevents hammering.
- **Structured output helper:** wraps a call with `response_format: { type: "json_object" }`
  and JSON-parses the result, for the self-judge step. Translation/refine calls stay raw
  text (they must preserve markers/tokens verbatim).

`DeepSeekTranslator.chat()` is refactored to call `fetchWithRetry`. No behavior change to
prompts or pricing.

## Layer 2 — Quality pipeline (`lib/core/quality/`)

Extracted from `translateBlocks`. Operates per chunk on the draft.

### Local validators (pure functions, no API) — `quality/validators.ts`

1. **Marker/token integrity:** every block marker and placeholder token from the source
   payload is present and unchanged in the output. On failure → existing per-block
   re-translation fallback (already in translator.ts).
2. **Omission / length-ratio:** for each block, ratio of translated plaintext length to
   source plaintext length. Outside a configured band (mode-dependent, e.g. 0.6–2.2 for
   EN→HU) → `omission` flag.
3. **Glossary adherence:** for each source glossary term occurring in the block, the
   target rendering must appear in the translation. Misses → `glossary` flag.

Validators return a `LocalReport { ok: boolean; flags: Flag[] }`.

### Self-judge — `quality/judge.ts`

One cheap, low-temperature call returning **structured JSON**:
`{ "score": 1-5, "omission": bool, "accuracy": bool, "fluency": bool }`.
Parsed via the transport JSON helper; on parse failure, conservatively treat as
`score=3` (needs refine). The judge prompt's rubric is weighted by precision mode.

### Routing — `quality/route.ts`

Given the local report + judge verdict, decide effort (bounded; never infinite):

| Condition | Action |
|---|---|
| local clean AND score ≥ 4 | accept draft |
| score = 3, or a minor local flag | refine on flash, re-validate once |
| score ≤ 2, or `omission`/`accuracy` flag | escalate: refine on **reasoner**; in `fidelity` mode also a targeted **back-translation accuracy check** on this chunk only |

**Iteration cap:** at most 1 refine + 1 escalation per chunk, then accept the best result.
All usage (draft, judge, refine, escalation, back-translation) folds into the existing
cost accounting.

## Layer 3 — Orchestration (existing, minor changes)

`job.ts` keeps the flat parallel chunk pool, shared glossary, and shared style anchor.
The only change: `processChunk` delegates the draft→validate→judge→route flow to the
quality pipeline instead of calling `translateBlocks`' inline refine logic.

## Configuration

- `TRANSLATION_PRECISION` = `balanced` (default) | `fidelity` | `natural`.
  - Affects: judge rubric weighting, length-ratio bands, and whether back-translation is
    enabled for escalated chunks (`fidelity` only).
- Existing env vars remain and stay backward-compatible:
  `TRANSLATION_REFINE`, `TRANSLATION_REFINE_SELECTIVE`, `TRANSLATION_REASONER_HARD`,
  `TRANSLATION_CONCURRENCY`, `COST_CEILING_USD`. Selective/reasoner behavior is now
  expressed through the routing table; the flags gate whether those routes are taken.
- **Per-book override:** precision mode is stored on the job state (engine reads it).
  Plumbed through upload/translate; UI toggle is out of scope for this iteration.

## Error handling & resume

- Transient errors are absorbed by transport retries.
- A chunk that still fails after retries is **logged and left uncached**; the pool
  continues with the other chunks. One bad chunk never aborts the whole book.
- At the end, if any chunk is missing, the job ends as `error` with a
  "N szakasz nem sikerült" message. Successful chunks are cached, so **resume retries
  only the missing ones** (existing cache model — no extra machinery).
- Cost ceiling, pause, and cancel semantics are unchanged.

## Testing

- **Transport:** injected `fetch` — retries `429`→`200`, honors `Retry-After`, does NOT
  retry `400`, aborts on timeout. Assert attempt counts and backoff bounds.
- **Validators:** pure-function unit tests for omission/length-ratio, glossary adherence,
  marker/token integrity.
- **Judge:** JSON parse + conservative fallback on malformed output.
- **Routing:** spy provider with scripted verdicts → assert accept / refine / escalate
  paths and the iteration cap.
- **Failure isolation:** a fake provider that fails N times → one bad chunk doesn't kill
  the book; resume re-does only the missing chunks.
- All **47 existing tests stay green**; deterministic via FakeTranslator.

## File-level impact

| File | Change |
|---|---|
| `lib/core/providers/http.ts` | NEW — fetchWithRetry, timeout, backoff, json helper |
| `lib/core/providers/deepseek.ts` | use fetchWithRetry; json_object for judge; reasoner already wired |
| `lib/core/quality/validators.ts` | NEW — local QE validators |
| `lib/core/quality/judge.ts` | NEW — structured self-judge |
| `lib/core/quality/route.ts` | NEW — effort routing + iteration cap |
| `lib/core/translator.ts` | delegate refine/estimate to quality pipeline; shrink |
| `lib/core/job.ts` | processChunk uses the pipeline; per-chunk failure isolation |
| `lib/core/cost.ts` | unchanged (usage already aggregated) |
| `lib/server/config.ts` | add `precision`; keep existing flags |
| `lib/server/jobs.ts` | pass precision through |
| `test/*` | new transport/validator/judge/route/failure tests |
| `README.md`, deploy configs | document `TRANSLATION_PRECISION` |

## Expected outcome

- **Precision:** cheap local + LLM checks catch dropped/garbled/inconsistent output that
  the current blind pipeline misses; escalation puts reasoning only where it helps.
- **Speed/cost:** unchanged for clean chunks (most of them), extra spend only on the few
  weak ones; transport keeps throughput high and stable under load instead of dying on a
  single transient error.
