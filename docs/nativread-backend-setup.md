# NativRead Backend Setup

This repository can run as a dedicated NativRead translator backend. It uses the same
translation core as the web workshop, but a separate Docker Compose file, port, and
volumes.

## Quick Start

### Local Checkout -> Proxmox LXC

This path does not require the GitHub repo to exist on the Proxmox host. It packs the
current local checkout and deploys it over SSH:

```bash
PROXMOX_HOST=root@192.168.1.10 PROVIDER_API_KEY=... \
  bash scripts/deploy-nativread-proxmox.sh
```

Useful overrides:

```bash
CTID=151 PORT=48218 STORAGE=local-lvm BRIDGE=vmbr0 \
PROXMOX_HOST=root@192.168.1.10 PROVIDER_API_KEY=... \
  bash scripts/deploy-nativread-proxmox.sh
```

### GitHub Clone -> Docker Host

```bash
git clone git@github.com:karsai20/nativread-translator-backend.git
cd nativread-translator-backend
bash scripts/setup-nativread-backend.sh
```

The first run creates `.env.nativread`. Edit it:

```env
TRANSLATION_PROVIDER=gemini
PROVIDER_API_KEY=...
PROVIDER_MODEL=gemini-2.5-flash
```

Then start it:

```bash
bash scripts/setup-nativread-backend.sh
```

Defaults:

- Container: `nativread-translator`
- Host port: `48218`
- Internal app port: `48217`
- Jobs volume: `nativread-translator-jobs`
- Library volume: `nativread-translator-library`
- Entitlements volume: `nativread-translator-entitlements`

## NativRead App

The iOS app defaults to:

```text
http://127.0.0.1:48218
```

That works for the iOS Simulator when Docker runs on the same Mac. On a real iPhone,
set the backend URL in NativRead Settings to:

```text
http://<mac-or-server-lan-ip>:48218
```

Keep the backend on a trusted LAN while `REQUIRE_TRANSLATION_ENTITLEMENTS=0`.
Before exposing it on a public host, set `NATIVREAD_BACKEND_SHARED_SECRET`, require
that header from the app, and enable `REQUIRE_TRANSLATION_ENTITLEMENTS=1` after
StoreKit server verification is wired to `/api/entitlements/translation`.

Uploads are scoped by the `x-nativread-user-id` header. Without an account this can
be the app's anonymous install identifier; later Sign in with Apple should replace
it with the server-issued user id. Source-hash dedup is user-scoped so one user's
translated EPUB is never served to another user just because the source book hash
matches.

## Later Kubernetes Shape

Use the same image with different env and persistent volumes:

- `APP_PROFILE=nativread`
- `PORT=48217`
- `JOBS_DIR=/data/jobs`
- `LIBRARY_DIR=/data/library`
- `ENTITLEMENTS_DIR=/data/entitlements`
- `REQUIRE_TRANSLATION_ENTITLEMENTS=1`
- `TRANSLATION_PROVIDER=gemini`
- `PROVIDER_MODEL=gemini-2.5-flash`

The service should expose container port `48217`; ingress or service type decides the
external URL.

For Kubernetes, run the Next.js container stateless except for mounted persistent
storage. The current file-backed stores map cleanly to three PVCs (`jobs`, `library`,
`entitlements`). When traffic grows, replace the entitlement store with Postgres first;
job artifacts and finished EPUBs can move to S3/R2-compatible object storage without
changing the mobile API contract.
