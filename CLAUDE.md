# nativread-translator

Self-hosted web EPUB translator EN→HU (Next.js 15 App Router, React 19, Bun, Tailwind 4). Purpose: the `NativRead Web` product (`nativread-web` at runtime), the translation backend for the NativRead iOS app (`docker-compose.nativread.yml`), and a reusable translation core. Plan: `PLAN.md`.

## Commands

```bash
bun install
bun test            # all tests, no key needed
bun run typecheck
bun run dev         # http://localhost:48217
bun run eval <book.epub>   # quality/cost comparison of model configs (real key, real cost)
bun run eval:probe         # which body shape actually controls Gemini thinking
```

With no provider key a deterministic **fake provider** runs the whole flow — use it for dev and tests. Real translation: `.env` with `TRANSLATION_PROVIDER`, `PROVIDER_API_KEY`, `PROVIDER_MODEL` (recommended: gemini / gemini-2.5-flash).

## Architecture

- `lib/core/` — provider-agnostic translation engine (chunker, glossary, markup, `providers/`). **Keep it framework-free**: it is designed to port to Swift for NativRead Phase 2. No Next/React/Node-only imports here.
- `lib/server/`, `lib/jobs/` — server orchestration and job runner; `app/` — UI + API routes; `library/` — household library of translated books (never re-translate an already-translated book).

## Quality invariants (the product's whole point — don't "optimize" away)

- Context-aware multi-paragraph chunks, not per-paragraph calls.
- Continuity across chunk seams, in two parts because chunks translate in parallel: one
  book-wide style anchor (the translated tail of the first chunk, keeps te/ön/maga
  consistent) plus the preceding chunk's SOURCE tail (resolves pronouns and references).
- Book-wide glossary for name/term consistency: heuristically seeded, then resolved in one
  pass before translation starts, and persisted in the manifest so a resume cannot re-decide.
- DOM-preserved markup: the model sees text nodes only — links, attrs, italics, ids stay in the original tree.
- Selective polish pass (`TRANSLATION_REFINE`): a judge grades each draft and names the weak
  blocks, and only those blocks are regenerated. Output tokens are ~85% of a chunk's cost.
- Model choice, temperature and refine policy are decided by measurement, not taste:
  `bun run eval <book.epub>` (see `eval/`).

Launch is Hungarian-only; new target languages must pass the same quality pipeline first (see `../nativread/TODOS.md`).
