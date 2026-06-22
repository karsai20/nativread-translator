# quire-translator

A small, self-hosted **web book translator**: upload an EPUB, get it back in Hungarian,
read it in the browser (bilingual toggle) or download the translated EPUB.

It exists to **de-risk Quire's flagship bet** — that chunked AI translation produces
Hungarian a non-technical native reader will actually read — and to grow a **reusable
translation core** (chunking, markup preservation, glossary carry, resumable jobs,
swappable provider) whose design ports to Swift. See [`PLAN.md`](./PLAN.md).

## Quick start (local, zero cost)

```bash
bun install
bun test            # full core suite incl. resume + EPUB round-trip (no API calls)
bun run dev         # http://0.0.0.0:48217
```

With **no** `PROVIDER_API_KEY` set, it runs a deterministic **fake** provider — the
whole upload → translate → read → download flow works end-to-end without spending a
cent. Set a key to translate for real:

```bash
cp .env.example .env     # set PROVIDER_API_KEY=sk-... (DeepSeek)
bun run start
```

> When a key is set, translation **sends the book text to DeepSeek**. The key is read
> only from `.env` and never logged.

## How it works

```
EPUB → parse (container → OPF → spine) → chunk spine items
     → protect inline tags as tokens → translate (provider + glossary)
     → restore tags → re-stitch XHTML → write EPUB
```

Each translated chunk is persisted under `jobs/<id>/chunks/`, so a killed process
**resumes** from the last completed chunk and never re-pays for finished work.

### Layout

| Path | What |
|------|------|
| `src/core/` | Reusable heart — `epub`, `chunker`, `markup`, `glossary`, `translator`, `cost`, `job`, `providers/{deepseek,fake}`. No server/web imports (ports to Swift). |
| `src/server/` | Bun HTTP server (`config`, `index`, `routes`). Binds `HOST:PORT`. |
| `src/web/` | Framework-free UI: upload → progress → bilingual reader. |
| `test/` | Headless tests against the fake provider. |
| `deploy/` | Proxmox deployment (LXC script + systemd unit). |

## Configuration

| Env | Default | Meaning |
|-----|---------|---------|
| `PROVIDER_API_KEY` | _(empty)_ | DeepSeek key. Empty → fake provider. |
| `HOST` | `0.0.0.0` | Bind address (0.0.0.0 for in-container reachability). |
| `PORT` | `48217` | Uncommon port to avoid collisions. |
| `JOBS_DIR` | `./jobs` | Where resume state lives (mount a volume in a container). |
| `COST_CEILING_USD` | `10` | Hard per-book cost cap; aborts before overrun. |

## Setup guide

### A. Proxmox — one-shot install (recommended)

Run **on the Proxmox host shell, as root**. It creates a dedicated unprivileged
Debian LXC, installs Bun, clones this (private) repo, builds it, and starts it as a
systemd service on an uncommon port (`48217`).

The repo is private, so pass a GitHub token with `repo` scope. One paste-able line:

```bash
GH_TOKEN=ghp_your_token CTID=150 PORT=48217 PROVIDER_API_KEY=sk-deepseek-key \
  bash -c "$(curl -fsSL -H "Authorization: token ghp_your_token" \
    https://raw.githubusercontent.com/karsai20/quire-translator/main/deploy/proxmox-install.sh)"
```

- Omit `PROVIDER_API_KEY` to run the **zero-cost fake provider** (full dry run, no API).
- Override any of `CTID`, `PORT`, `CORES`, `MEMORY_MB`, `DISK_GB`, `BRIDGE`, `STORAGE`,
  `IPCONFIG` (e.g. `192.168.1.50/24` + `GATEWAY`), `BRANCH`.
- When it finishes it prints the URL, e.g. `http://192.168.1.50:48217`.

Update later:

```bash
pct exec 150 -- bash -lc 'cd /opt/quire-translator && git pull && \
  /root/.bun/bin/bun install && bun run build:web && systemctl restart quire-translator'
```

> The token is used only to clone and is scrubbed from the saved git remote. The app
> has **no auth** — keep it on a trusted LAN behind the Proxmox firewall. The only
> egress is the user-initiated DeepSeek call.

### B. Docker (a Proxmox Docker VM, or any host)

```bash
git clone git@github.com:karsai20/quire-translator.git && cd quire-translator
cp .env.example .env          # set PROVIDER_API_KEY (optional), PORT, COST_CEILING_USD
docker compose up -d --build  # -> http://<host>:48217
```

`jobs/` is on a named volume, so `docker compose restart` resumes in-flight work.

### C. Local development

```bash
bun install
bun test            # 22 tests, zero API cost
bun run dev         # http://0.0.0.0:48217 (fake provider unless PROVIDER_API_KEY is set)
```

More detail and the offline (no-Docker, repo-already-present) LXC variant:
[`deploy/README.md`](./deploy/README.md).
