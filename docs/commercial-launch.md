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
- **Sell one book at a time, not credits.** A credit balance asks the wrong
  question at the moment of purchase ("will 250 credits be enough?"), strands
  unusable remainders, and contradicts what the in-app terms already promise.
  A length tier is chosen server-side from the measured character count, and the
  device only learns which App Store product to buy.
- Six consumable tiers, by source characters: ≤150k, ≤300k, ≤500k, ≤800k,
  ≤1.2M, and ≤3M. A book above the top tier is refused at upload, because the
  top tier stops covering its own translation cost well before that.
  The table lives in `cloudflare/src/database.ts` (`BOOK_TIERS`) and is the only
  place a tier is decided.
- The price shown to the reader always comes from StoreKit's `displayPrice`,
  never from our own table: it is the localized figure the App Store will
  actually charge.
- A verified transaction grants an entitlement per `(userId, sourceHash,
  targetLanguage)`. There is no reservation to settle and no refund path: a
  failed job keeps its entitlement, so the retry costs the customer nothing.
- Give one first-chapter preview per account and source hash.
- Set tier prices only after benchmarking at least 10–20 representative EPUBs.
  Include input, output, refinement/retry, Apple commission, hosting,
  payment/tax overhead, and support; target a 65–75% contribution margin.
  At the measured $0.91 per million source characters (`PLAN.md`,
  gemini-3.1-flash-lite), the $11.99 tier holds ~68% contribution at its 3M
  character cap with Hungarian VAT and the 15% Small Business commission.

### Implemented flow

- `POST /api/upload` returns the `source-chars-v1` quote and a `price` block
  naming the tier and its App Store product id. Over the top tier it returns
  `413 book_too_long` before a job row exists.
- `POST /api/purchase` takes `{id, transactionId}`, looks the transaction up at
  Apple's App Store Server API, and requires it to name our bundle, a
  `Consumable`, the tier the book falls into, and the account's
  `appAccountToken`. Nothing the device claims about the purchase is trusted.
- The `book_purchases` primary key on `transaction_id` makes a replay a no-op
  and a receipt from another account a `409`; an `AFTER INSERT` trigger writes
  the entitlement in the same statement.
- The app finishes a StoreKit transaction only after the backend confirms it,
  and replays anything still unfinished on the next launch.
- Refund and revocation notifications (App Store Server Notifications V2) are
  not wired up. A transaction revoked before the purchase call is rejected;
  one revoked afterwards is not yet reversed.

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
2. App Store Connect: the six consumable products, an In-App Purchase API key for
   the App Store Server API, and an active Paid Applications agreement (without
   it `Product.products(for:)` returns nothing).
3. A sandbox purchase verified end to end against the deployed Worker.
4. Production domain/TLS, secret management, monitoring, rate limits, encrypted
   metadata backups, and a tested restore procedure.
5. Privacy notice, terms, deletion policy, takedown/contact process, and a data-flow
   inventory covering the translation provider.
6. Apple credential-revocation handling and account deletion.
