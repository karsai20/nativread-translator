# nativread-translator

The translation backend and **NativRead Web** application. A modern,
self-hosted **web book translator**: upload an EPUB, get it back in fluent
**Hungarian**, read it in the browser (bilingual toggle) or download the translated
EPUB. Translated books are kept in a **household library** so they are never
re-translated. Also serves the NativRead iOS app over the same API.

It also **de-risks NativRead's flagship bet** — that chunked AI translation produces
Hungarian a native reader actually accepts — and grows a **reusable translation core**
whose design ports to Swift (NativRead Phase 2). See [`PLAN.md`](./PLAN.md).

## Translation quality is the point

Provider choice is configurable; quality comes from **how** the model is used:

- **Context-aware chunks** — a whole multi-paragraph passage is translated in one call
  (not paragraph-by-paragraph), so tone, pronoun reference, and register stay coherent.
- **Rolling continuity** — the tail of the previous translation is carried forward so
  voice/formality (te / ön / maga) continue seamlessly across chunk seams.
- **Book-wide glossary** — names/terms stay consistent across chapters.
- **Literary prompt + polish pass** — asks for natural, idiomatic Hungarian (no
  translationese), then optionally self-edits the draft (`TRANSLATION_REFINE`).
- **DOM-preserved markup** — the model sees text nodes, not HTML. Links, attributes,
  italics, emphasis, images, IDs, and classes stay in the original DOM tree.

## Quick start (local, zero cost)

```bash
bun install
bun test            # 29 core tests incl. resume, context-aware translate, library
bun run dev         # http://localhost:48217  (or: bunx next dev -p 48217)
```

With **no** provider key, a deterministic **fake** provider runs the whole flow at
zero cost. Set a provider, key, and model to translate for real:

```bash
cp .env.example .env     # recommended: TRANSLATION_PROVIDER=gemini, PROVIDER_API_KEY=..., PROVIDER_MODEL=gemini-2.5-flash
bun run build && bun run start
```

> When a real provider is configured, translation sends the book text to that provider.
> Keys are read only from the environment and never logged.

## Stack & layout

Next.js (App Router) · shadcn-style UI · Tailwind v4 · framework-agnostic core.

| Path | What |
|------|------|
| `lib/core/` | Reusable heart — `epub`, `chunker`, `html-segments`, `glossary`, `translator`, `cost`, `job`, `library`, `providers/*`. No Next/UI deps (ports to Swift). |
| `lib/server/` | `config` + in-memory job registry wiring routes to the core. |
| `app/api/` | `upload`, `translate`, `status`, `result`, `library` route handlers. |
| `app/`, `components/` | Hungarian-first UI: uploader → progress → bilingual reader → library. |
| `test/` | Headless tests against the fake provider. |
| `deploy/` | Proxmox install (LXC one-shot + systemd) + Docker. |

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `TRANSLATION_PROVIDER` | `fake` | `fake`, `openai`, `gemini`, or `deepseek`. |
| `PROVIDER_API_KEY` | _(empty)_ | Shared household provider key. With no explicit provider, a key infers `openai`. |
| `PROVIDER_MODEL` | _(empty)_ | Required for `openai` and `gemini`; optional override for `deepseek`. |
| `PROVIDER_BASE_URL` | _(empty)_ | Optional OpenAI-compatible chat completions URL override. |
| `PROVIDER_REASONER_MODEL` | _(empty)_ | Optional model for hardest refinement passes. |
| `PORT` | `48217` | Uncommon port. |
| `JOBS_DIR` | `jobs` | Resume state (mount a volume in a container). |
| `LIBRARY_DIR` | `library` | Persistent household library. |
| `COST_CEILING_USD` | `10` | Hard per-book cap; aborts before overrun. |
| `TRANSLATION_REFINE` | `1` | Second polish pass for quality (`0` to disable). |
| `TRANSLATION_REFINE_SELECTIVE` | `1` | Refine only chunks a cheap quality estimate judges weak (`0` = refine every chunk). |
| `TRANSLATION_REASONER_HARD` | `1` | Refine the weakest chunks on `PROVIDER_REASONER_MODEL` when configured. |
| `TRANSLATION_PRECISION` | `balanced` | Quality mode: `balanced`, `fidelity` (stricter on meaning/omission + back-translation), or `natural`. |
| `TRANSLATION_CONCURRENCY` | `4` | Chapters translated in parallel (1–8). Higher = faster, more API load. |
| `MAX_EPUB_UPLOAD_BYTES` | `33554432` | Maximum compressed EPUB upload (32 MiB). |
| `MAX_EPUB_ENTRIES` | `2000` | Maximum ZIP central-directory entries. |
| `MAX_EPUB_UNCOMPRESSED_BYTES` | `134217728` | Maximum total expanded EPUB size (128 MiB). |
| `APPLE_CLIENT_IDS` | _(empty)_ | Sign in with Apple audiences; setting this activates public authenticated mode. |
| `NATIVREAD_SESSION_SECRET` | _(empty)_ | At least 32 random characters; signs 30-day backend sessions after Apple login. |
| `REQUIRE_TRANSLATION_ENTITLEMENTS` | `0` | Require either a legacy entitlement or sufficient character credits for full-book jobs. |
| `STOREKIT_ALLOW_UNSIGNED_GRANTS` | `0` | Trusted-LAN test switch for `$0` placeholder credit purchases; never enable publicly. |
| `ARTIFACT_RETENTION_HOURS` | `24` in public mode, otherwise `0` | Maximum age of abandoned source/result artifacts; successful consumed downloads are deleted immediately. |

Recommended MVP provider: `gemini` with `PROVIDER_MODEL=gemini-2.5-flash`. It is
cheap enough for whole-book experiments while keeping better literary quality headroom
than Flash-Lite. Keep `TRANSLATION_REFINE_SELECTIVE=1` so the polish pass is spent only
where the first draft looks weak.

## Deploy to the cloud

Production runs on Cloudflare: a Worker API in front of EU D1, EU R2, a Queue
and a Workflow, with the translation itself in an EU Container. Provisioning,
secrets, the tenant boundary and the release gates live in
[`cloudflare/README.md`](./cloudflare/README.md).

```bash
bun run cf:typecheck && bun run cf:dry-run
bun run cf:deploy
```

The Next/Bun server in this repo stays for LAN development and rollback. Any
host that reads a Dockerfile plus a persistent disk (Railway, Fly.io, a plain
VPS) still runs it, but it is no longer the production target.

## Deploy on Proxmox

Its own container, uncommon port, persistent library — **one paste-able command**:

```bash
GH_TOKEN=ghp_xxx CTID=150 PORT=48217 TRANSLATION_PROVIDER=gemini PROVIDER_API_KEY=... PROVIDER_MODEL=gemini-2.5-flash \
  bash -c "$(curl -fsSL -H "Authorization: token ghp_xxx" \
    https://raw.githubusercontent.com/karsai20/nativread-translator/main/deploy/proxmox-install.sh)"
```

Full guide (LXC + Docker, firewall, updates): [`deploy/README.md`](./deploy/README.md).
```bash
docker compose up -d --build   # the Docker alternative
```

## NativRead mobile backend

Run a separate container for the iPhone app so its jobs/library do not mix with
NativRead Web:

```bash
git clone git@github.com:karsai20/nativread-translator.git
cd nativread-translator
bash scripts/setup-nativread-backend.sh
```

The first run creates `.env.nativread`; add `PROVIDER_API_KEY`, then run the script
again. It listens on `http://<host>:48218` by default. The iOS Simulator uses
`http://127.0.0.1:48218` when entered in NativRead Settings; on a real iPhone set
the Mac/server LAN IP there instead. For a no-charge end-to-end purchase test, set
`REQUIRE_TRANSLATION_ENTITLEMENTS=1` and `STOREKIT_ALLOW_UNSIGNED_GRANTS=1` only on
the trusted LAN backend. See
[`docs/nativread-backend-setup.md`](./docs/nativread-backend-setup.md).
