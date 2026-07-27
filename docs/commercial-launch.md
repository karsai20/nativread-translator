# NativRead commercial launch decisions

This document records the intended public product boundary. It is an engineering
and product decision record, not legal advice.

## Launch scope

- Require Sign in with Apple just in time, before the free chapter or a paid job.
- Require the uploader to attest that they lawfully acquired the file and have
  permission or another legal basis to translate it for personal use.
- Start commercially with public-domain and explicitly licensed works. Do not
  market protected commercial-book translation until Hungarian/EU IP counsel has
  reviewed the exact service flow or the necessary licences are in place.
- A rights checkbox, private use, deletion, or email delivery does not itself grant
  translation rights.

## Delivery and retention

- Return the finished EPUB through an authenticated, one-time consumed download in
  the app. Delete the source, chunks, output, job manifest, and library copy only
  after the full response has been buffered successfully.
- Send email only as an optional “your translation is ready” notification. Do not
  attach the EPUB: mail relays, providers, recipient mailboxes, and backups would
  create extra retained copies outside the product's deletion controls.
- Remove abandoned jobs and unclaimed results after 24 hours. Keep only the minimum
  durable account, purchase, quote, and accounting records; never put book text in
  logs or analytics.

## Metering and StoreKit

- Meter source Unicode code points after EPUB markup is excluded. Do not expose
  translation chunks as a billing unit: chunk boundaries change with models and
  pipeline tuning and are not understandable to customers.
- Define one internal credit as 1,000 source code points. Show users both the source
  character count and the exact credit quote before purchase or confirmation.
- Sell fixed, non-expiring consumable credit packs through StoreKit. Apple product
  prices are fixed tiers, while a signed, versioned server quote can consume a
  dynamic number of credits per book.
- Reserve quoted credits atomically when a job starts. Finalize on successful
  delivery; refund automatically on terminal failure or expiry. Never charge for a
  retry caused by the service.
- Give one first-chapter preview per account and source hash. Bind the quote to the
  normalized source hash, character count, source and target languages, quality
  mode, model-price version, credit amount, and expiry.
- Set retail pack prices only after benchmarking at least 10–20 representative
  EPUBs. Include input, output, refinement/retry, Apple commission, hosting,
  payment/tax overhead, and support; target a 65–75% contribution margin.

### Implemented placeholder flow

- `POST /api/upload` now returns a server-calculated `source-chars-v1` quote:
  visible normalized source characters, required credits, and characters per
  credit. Markup and internal translation chunk boundaries are excluded.
- `GET /api/credits` returns the account balance and the 250/600/1,200-credit
  product catalogue. Full jobs reserve the exact quote, successful consumed
  delivery finalizes it, and failure/cancellation/expiry refunds it.
- `POST /api/credits/purchase` provides an idempotent transaction-id grant only
  when `STOREKIT_ALLOW_UNSIGNED_GRANTS=1`. This switch is for a trusted LAN and
  automated tests only; keep it `0` on any public deployment.
- The current ledger is a file-backed, single-instance launch implementation.
  Before horizontal scaling, move purchases and reservations into a transactional
  database with a unique StoreKit transaction-id constraint.

## Initial hosting

- Deploy one EU VM in Hetzner Nuremberg: CX23 (2 vCPU, 4 GB RAM, 40 GB disk) plus
  IPv4, Docker Compose, Caddy HTTPS, and `api.<domain>`. As of 2026-07-14 the
  [official June 2026 price table](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/#cloud-servers)
  lists CX23 at EUR 5.49/month excluding VAT and IPv4; re-check before ordering.
- Keep persistent metadata and credit-ledger backups encrypted and separate. Do not
  back up source or translated EPUB volumes.
- Upgrade to CX33 when measured memory pressure or concurrency requires it. Add
  object storage only if the single-node delivery path becomes a real reliability
  constraint, and then configure explicit encryption and lifecycle deletion first.

## Required before paid launch

1. Hungarian/EU copyright and consumer-law review of the complete customer flow.
2. App Store Connect consumable products and server-side transaction verification.
3. Replace the debug purchase grant with signed StoreKit transaction verification;
   retain the implemented character quote, reservation, finalization, and refund
   rules in a transactional production ledger.
4. Production domain/TLS, secret management, monitoring, rate limits, encrypted
   metadata backups, and a tested restore procedure.
5. Privacy notice, terms, deletion policy, takedown/contact process, and a data-flow
   inventory covering the translation provider.
6. Apple credential-revocation handling and account deletion.
