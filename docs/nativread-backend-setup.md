# NativRead Backend Setup

This repository can run as a dedicated NativRead translator backend. It uses the same
translation core as NativRead Web, but a separate Docker Compose file, port, and
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
git clone git@github.com:karsai20/nativread-translator.git
cd nativread-translator
bash scripts/setup-nativread-backend.sh
```

The first run creates `.env.nativread`. Edit it:

```env
TRANSLATION_PROVIDER=gemini
PROVIDER_API_KEY=...
PROVIDER_MODEL=gemini-2.5-flash
# Use a billing-enabled paid Gemini API project. The public iOS client must
# not use Gemini's unpaid service tier.
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

For local development, set the backend URL in NativRead Settings to:

```text
http://127.0.0.1:48218
```

That works for the iOS Simulator when Docker runs on the same Mac. On a real iPhone,
set the backend URL in NativRead Settings to:

```text
http://<mac-or-server-lan-ip>:48218
```

For the complete placeholder purchase flow on a trusted LAN, use:

```env
REQUIRE_TRANSLATION_ENTITLEMENTS=1
STOREKIT_ALLOW_UNSIGNED_GRANTS=1
```

This enables server-calculated character quotes and fake 250/600/1,200-credit
purchases without charging money. Never expose that configuration publicly: anyone
who can authenticate to it can mint test credits. Use
`STOREKIT_ALLOW_UNSIGNED_GRANTS=0` everywhere except local testing.

Keep the backend on a trusted LAN while `REQUIRE_TRANSLATION_ENTITLEMENTS=0` or
`STOREKIT_ALLOW_UNSIGNED_GRANTS=1`.
Before exposing it on a public host, set `APPLE_CLIENT_IDS=com.karsai.nativread`,
set a random `NATIVREAD_SESSION_SECRET`, and enable
`REQUIRE_TRANSLATION_ENTITLEMENTS=1` after signed StoreKit verification replaces
the unsigned purchase route. Keep `ARTIFACT_RETENTION_HOURS=24` so abandoned
uploads and unclaimed translations are removed automatically; a successful consumed
download is deleted immediately regardless of this fallback TTL. Public mode
enforces a 30-day maximum even if a larger value is configured.

Production account deletion also needs an Apple Sign in with Apple private
key. Configure `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` (the
full `.p8` value, with line breaks encoded as `\n` in a single-line env
value). When the user confirms deletion with Apple, the backend verifies the
fresh identity token belongs to the current account, exchanges its one-time
authorization code, revokes the resulting Apple token, and only then deletes
the server account. If verification or revocation fails, no account data is
deleted so the user can safely retry.

The public translation route also requires the current Terms version and a
separate, versioned AI-processing permission that names the configured
provider. Missing, stale, or mismatched permission is rejected server-side;
this prevents an older client from bypassing the disclosure screen.

On a public host, uploads are scoped to the stable user id derived from Sign in
with Apple. The install-id header remains a LAN/dev-only fallback. Source-hash
dedup is user-scoped so one user's translated EPUB is never served to another user
just because the source book hash matches.

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
