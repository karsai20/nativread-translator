# quire-translator

A modern, self-hosted **web book translator**: upload an EPUB, get it back in fluent
**Hungarian**, read it in the browser (bilingual toggle) or download the translated
EPUB. Translated books are kept in a **household library** so they are never
re-translated.

It also **de-risks Quire's flagship bet** — that chunked AI translation produces
Hungarian a native reader actually accepts — and grows a **reusable translation core**
whose design ports to Swift (Quire Phase 2). See [`PLAN.md`](./PLAN.md).

## Translation quality is the point

DeepSeek is the only model, so quality comes from **how** it's used:

- **Context-aware chunks** — a whole multi-paragraph passage is translated in one call
  (not paragraph-by-paragraph), so tone, pronoun reference, and register stay coherent.
- **Rolling continuity** — the tail of the previous translation is carried forward so
  voice/formality (te / ön / maga) continue seamlessly across chunk seams.
- **Book-wide glossary** — names/terms stay consistent across chapters.
- **Literary prompt + polish pass** — asks for natural, idiomatic Hungarian (no
  translationese), then optionally self-edits the draft (`TRANSLATION_REFINE`).
- **Lossless markup** — inline tags become placeholder tokens, restored after
  translation, so italics/links/emphasis survive intact.

## Quick start (local, zero cost)

```bash
bun install
bun test            # 29 core tests incl. resume, context-aware translate, library
bun run dev         # http://localhost:48217  (or: bunx next dev -p 48217)
```

With **no** `PROVIDER_API_KEY`, a deterministic **fake** provider runs the whole flow at
zero cost. Set the key to translate for real:

```bash
cp .env.example .env     # PROVIDER_API_KEY=sk-... (DeepSeek)
bun run build && bun run start
```

> When a key is set, translation **sends the book text to DeepSeek**. The key is read
> only from the environment and never logged.

## Stack & layout

Next.js (App Router) · shadcn-style UI · Tailwind v4 · framework-agnostic core.

| Path | What |
|------|------|
| `lib/core/` | Reusable heart — `epub`, `chunker`, `markup`, `glossary`, `translator`, `cost`, `job`, `library`, `providers/{deepseek,fake}`. No Next/UI deps (ports to Swift). |
| `lib/server/` | `config` + in-memory job registry wiring routes to the core. |
| `app/api/` | `upload`, `translate`, `status`, `result`, `library` route handlers. |
| `app/`, `components/` | Hungarian-first UI: uploader → progress → bilingual reader → library. |
| `test/` | Headless tests against the fake provider. |
| `deploy/` | Proxmox install (LXC one-shot + systemd) + Docker. |

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `PROVIDER_API_KEY` | _(empty)_ | Shared household DeepSeek key. Empty → fake provider. |
| `PORT` | `48217` | Uncommon port. |
| `JOBS_DIR` | `jobs` | Resume state (mount a volume in a container). |
| `LIBRARY_DIR` | `library` | Persistent household library. |
| `COST_CEILING_USD` | `10` | Hard per-book cap; aborts before overrun. |
| `TRANSLATION_REFINE` | `1` | Second polish pass for quality (`0` to disable). |

## Deploy on Proxmox

Its own container, uncommon port, persistent library — **one paste-able command**:

```bash
GH_TOKEN=ghp_xxx CTID=150 PORT=48217 PROVIDER_API_KEY=sk-deepseek \
  bash -c "$(curl -fsSL -H "Authorization: token ghp_xxx" \
    https://raw.githubusercontent.com/karsai20/quire-translator/main/deploy/proxmox-install.sh)"
```

Full guide (LXC + Docker, firewall, updates): [`deploy/README.md`](./deploy/README.md).
```bash
docker compose up -d --build   # the Docker alternative
```
