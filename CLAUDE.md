# nativread-translator

Self-hosted web EPUB translator EN→HU (Next.js 15 App Router, React 19, Bun, Tailwind 4). Purpose: the translation backend for the NativRead iOS app (`docker-compose.nativread.yml`, requests scoped by install id) plus a reusable translation core. Formerly named `quire-translator` (Quire→NativRead rebrand). Plan: `PLAN.md`.

## Commands

```bash
bun install
bun test            # all tests, no key needed
bun run typecheck
bun run dev         # http://localhost:48217
```

With no provider key a deterministic **fake provider** runs the whole flow — use it for dev and tests. Real translation: `.env` with `TRANSLATION_PROVIDER`, `PROVIDER_API_KEY`, `PROVIDER_MODEL` (recommended: gemini / gemini-2.5-flash).

## Architecture

- `lib/core/` — provider-agnostic translation engine (chunker, glossary, markup, `providers/`). **Keep it framework-free**: it is designed to port to Swift for Quire Phase 2. No Next/React/Node-only imports here.
- `lib/server/`, `lib/jobs/` — server orchestration and job runner; `app/` — UI + API routes; `library/` — household library of translated books (never re-translate an already-translated book).

## Quality invariants (the product's whole point — don't "optimize" away)

- Context-aware multi-paragraph chunks, not per-paragraph calls.
- Rolling continuity tail across chunk seams (keeps te/ön/maga register consistent).
- Book-wide glossary for name/term consistency; glossary is learned, with retry backoff.
- DOM-preserved markup: the model sees text nodes only — links, attrs, italics, ids stay in the original tree.
- Optional polish pass via `TRANSLATION_REFINE`.

Launch is Hungarian-only; new target languages must pass the same quality pipeline first (see `../nativread/TODOS.md`).
