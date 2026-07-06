# Phase 1a — public free-chapter demand probe (task list)

Source: `../nativread/docs/translator-plan.md` (Phase 1a) + a code audit of this repo
on 2026-07-06. Phase 1a goal: expose **one stateless "translate the real first
chapter" endpoint** to the public internet **safely** — real login + ownership
attestation + abuse bounds + provider disclosure + account deletion + a global
spend kill-switch. The free chapter is the demand signal. **No paid machinery yet.**

Effort is labelled human / CC (agent) time. Status reflects the current code.

## Current state (audit summary)

- **Auth:** single shared secret (`NATIVREAD_BACKEND_SHARED_SECRET`) + an
  **untrusted** `x-nativread-user-id` header — `lib/server/request-context.ts`.
  No Apple/Google verification. The whole per-user isolation rests on a spoofable id.
- **Per-user scope:** `lib/core/library.ts` already filters `listLibrary` /
  `findBySourceHash` / `saveToLibrary` by `userId`. Good foundation — but only as
  trustworthy as the (currently spoofable) identity.
- **Entitlements:** `app/api/entitlements/translation/route.ts` exists and **refuses
  to grant** unless `STOREKIT_ALLOW_UNSIGNED_GRANTS=1` (returns 501). Real StoreKit
  verification is NOT implemented — correctly Phase 1b, gated off by default.
- **Free chapter:** `sample` mode translates a leading **fraction** (~5%,
  `takeLeadingFraction` in `lib/core/job.ts`) reusing the full job machinery, and
  **bypasses** the entitlement gate (`!sample && requireEntitlements` in
  `app/api/translate/route.ts`). It does NOT skip front matter and has NO
  dedup/rate-limit/word-cap/kill-switch — this is the abuse surface.
- **Upload:** whole file buffered into memory then `unzipSync` — `app/api/upload/route.ts`.
  `lib/core/epub.ts` normalizes paths (`seg === ".." → parts.pop()`, some zip-slip
  cover) but has NO size cap / entry-count / uncompressed-size (zip-bomb) guard.
- **Rate limiting / global kill-switch:** none. Only per-book `COST_CEILING_USD`.
- **Account deletion/export:** no route.
- **Deploy:** Dockerfile + `docker-compose.nativread.yml`, `/data/jobs` + `/data/library`
  volumes, Proxmox homelab. `PLAN.md` still states the **stale** "household LAN, never
  public" posture and says to revisit if it ever goes public.

---

## A. Identity & trust boundary

- [x] **1a-1 (T2, P1) — Apple + Google id-token verification → stable userId. DONE 2026-07-06.**
  `lib/server/oidc.ts` (new): `verifyIdToken` tries each configured provider via
  `jose.jwtVerify` (JWKS signature, `iss`, `aud`, `exp`, alg pinned RS256), derives
  `userId = <provider>:<sub>`, no unverified-claim routing. `request-context.ts` is now
  async: **public mode** (any client id set) requires a verified Bearer id-token and the
  header path is unreachable; **dev/LAN mode** (no client id) keeps the shared-secret +
  header flow. Config: `APPLE_CLIENT_IDS` / `GOOGLE_CLIENT_IDS`. 14 tests; Codex security
  review clean.
  **Deferred (Phase 1b):** minting our own short session token — id-tokens are short-lived
  (Apple ~10min); fine for the seconds-long free chapter, needed once multi-minute jobs
  must survive backgrounding. **Still to do:** 1a-2 (enforce the verified userId across
  ALL routes, incl. `jobs`/`library`/`job/*` which don't call `requestContext` yet).
- [x] **1a-2 (T1 enforce, P1) — audit + lock per-user isolation. DONE 2026-07-06.**
  `jobs`, `library`, `job` DELETE, and `job/cancel|pause|resume` now call
  `requestContext` and gate on a new **strict, fail-closed** `ownsJob(state,userId)`
  (`Boolean(state?.userId) && state.userId === userId` — ownerless jobs are owned by
  nobody). List routes filter by owner; mutation routes 404 on unknown OR not-owned so
  existence never leaks. `status`/`result` unified on the same predicate (`result`
  returns 404 uniformly, no 404-vs-409 leak). `DELETE?withLibrary=1` drops the library
  copy only on positive ownership; a present-but-unverifiable library dir is refused,
  never blind-`rmSync`'d. 9 negative tests (cross-user list/delete/control, ownerless
  fail-closed, withLibrary cross-owner + unverifiable-meta). Codex reviewed across 3
  rounds — 2 High + 1 Medium found and fixed, final verdict clean.

## B. The free chapter itself

- [ ] **1a-3 (T3, P1, ~1d / ~2h) — stateless `translate-one-chapter` endpoint.**
  Today `sample` reuses volumes/manifest/resume. Add a lean route that takes an
  uploaded EPUB (or a prior `sourceHash`), translates just the one chapter, returns
  it, and **keeps nothing** (no `/data` write, no job registry entry).
- [ ] **1a-4 (T3 / outside-voice #3,#5, P1, ~1d / ~2h) — real first CONTENT chapter, front matter skipped.**
  `takeLeadingFraction` cuts a % from spine start = cover/title/copyright/TOC. Instead
  pick the first spine item past a word-count threshold / nav landmark. Files:
  `lib/core/job.ts`, `lib/core/epub.ts` (spine + nav).

## C. Abuse bounds (the free endpoint is the attack surface)

- [ ] **1a-5 (T4, P1, ~1d / ~2h) — global daily spend kill-switch.**
  None today. Persistent daily aggregate-spend counter + a hard env cap; when exceeded,
  the free endpoint 503s. Per-user caps don't bound aggregate spend across throwaway
  accounts.
- [ ] **1a-6 (abuse bounds, P1, ~1d / ~2h) — per-account/day rate limit + word cap + free-chapter dedup.**
  Login required (1a-1). One free chapter per `(userId, sourceHash)`; reject repeats;
  cap the translated chapter's word count; per-account/day request limit.
- [ ] **1a-7 (T5, P1, ~1d / ~2h) — public upload hardening.**
  Reject a request body over N MB before buffering; cap entry count and total
  uncompressed size (zip-bomb guard); keep the existing zip-slip path normalization.
  Files: `app/api/upload/route.ts`, `lib/core/epub.ts`.

## D. Legal-visible (compliance / reviewer-facing)

- [ ] **1a-8 (T16 / legal #4, P1, ~0.5d / ~1h) — AI-provider disclosure.**
  `/api/config` already returns `providerName`; confirm it names the chosen Western
  provider (not `fake`/`deepseek`) and the app shows it pre-first-translation.
- [ ] **1a-9 (T9 / legal #5, P1, ~1d / ~2h) — account + data deletion & export endpoint.**
  Delete a `userId`'s jobs/library/entitlements + metadata; export their data. Apple
  5.1.1(v) requires deletion independently of GDPR.
- [ ] **1a-10 (EU AI Act T25 backend half, P1, ~0.5d / ~1h) — machine-readable AI marker.**
  Embed an "AI-generated (machine translation)" marker in the delivered chapter's OPF
  metadata (`writeEpub` in `lib/core/epub.ts`). Art 50(2) applies **2026-08-02**. The
  iOS *visible* label half is already done (`../nativread`).

## E. Public deploy posture

- [ ] **1a-11 (P1, ~0.5d / ~2h) — public ingress + TLS + secrets.**
  Move off LAN-only: TLS (Caddy/Cloudflare), auth on every route (1a-1), AI key
  server-only (already env), no key in logs. See the hosting brief (`../nativread`
  session notes): Hetzner CPX21 EU + Cloudflare R2 + Supabase.
- [ ] **1a-12 (P2, ~0.5d / ~1h) — reconcile the stale PLAN.md legal posture.**
  `PLAN.md` still says "household LAN, never public." Update it to the public-operator
  posture in `../nativread/docs/legal-posture.md` so the repo doesn't contradict its
  own launch plan.

---

## Explicitly Phase 1b (NOT 1a)

Full job lifecycle/resume, object storage (R2/S3) for in-flight artifacts, StoreKit
server verification + entitlement + txn-dedupe (scaffolding exists, gated off by
`STOREKIT_ALLOW_UNSIGNED_GRANTS=0`), paid-job robustness (refund/redrive, ceiling
can't abort a paid job), iCloud/CloudKit durability, APNs, cross-chunk glossary as a
quality gate. Keep the entitlements route gated off until 1a lands.

## Suggested order

1a-1 → 1a-2 (identity first; everything else trusts it) → 1a-7 (harden the door) →
1a-3 → 1a-4 (the actual free chapter) → 1a-5 → 1a-6 (abuse bounds) → 1a-9, 1a-10, 1a-8
(compliance) → 1a-11, 1a-12 (deploy + docs).
