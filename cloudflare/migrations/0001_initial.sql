PRAGMA foreign_keys = ON;

CREATE TABLE accounts (
  user_id TEXT PRIMARY KEY CHECK(length(user_id) = 64),
  created_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY CHECK(length(id) = 36),
  user_id TEXT NOT NULL REFERENCES credit_accounts(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'queued', 'starting', 'running', 'done', 'error', 'cancelled'
  )),
  source_key TEXT NOT NULL UNIQUE,
  result_key TEXT,
  workflow_instance_id TEXT,
  provider TEXT NOT NULL,
  target_language TEXT NOT NULL DEFAULT 'hu' CHECK(length(target_language) BETWEEN 2 AND 8),
  sample INTEGER NOT NULL DEFAULT 0 CHECK(sample IN (0, 1)),
  source_hash TEXT NOT NULL CHECK(length(source_hash) = 64),
  title TEXT,
  spine_item_count INTEGER NOT NULL DEFAULT 0 CHECK(spine_item_count >= 0),
  source_characters INTEGER NOT NULL DEFAULT 0 CHECK(source_characters >= 0),
  required_credits INTEGER NOT NULL DEFAULT 0 CHECK(required_credits >= 0),
  quote_version TEXT NOT NULL,
  terms_version TEXT,
  ai_consent_version TEXT,
  ai_provider TEXT,
  translated_chunks INTEGER NOT NULL DEFAULT 0 CHECK(translated_chunks >= 0),
  total_chunks INTEGER NOT NULL DEFAULT 0 CHECK(total_chunks >= 0),
  error_code TEXT,
  error_message TEXT,
  cost_usd REAL NOT NULL DEFAULT 0 CHECK(cost_usd >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  delivered_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE INDEX jobs_user_created_idx ON jobs(user_id, created_at DESC);
CREATE INDEX jobs_status_created_idx ON jobs(status, created_at);
CREATE INDEX jobs_user_source_idx ON jobs(user_id, source_hash, target_language, sample, created_at DESC);
CREATE INDEX jobs_expiry_idx ON jobs(expires_at);

CREATE TABLE credit_accounts (
  user_id TEXT PRIMARY KEY REFERENCES accounts(user_id) ON DELETE CASCADE,
  purchased_credits INTEGER NOT NULL DEFAULT 0 CHECK(purchased_credits >= 0),
  reserved_credits INTEGER NOT NULL DEFAULT 0 CHECK(reserved_credits >= 0),
  spent_credits INTEGER NOT NULL DEFAULT 0 CHECK(spent_credits >= 0),
  updated_at TEXT NOT NULL,
  CHECK(purchased_credits >= reserved_credits + spent_credits)
);

CREATE TABLE credit_purchases (
  transaction_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK(credits > 0),
  created_at TEXT NOT NULL
);

CREATE INDEX credit_purchases_user_idx ON credit_purchases(user_id, created_at DESC);

CREATE TABLE credit_reservations (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK(credits > 0),
  quote_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved', 'finalized', 'refunded')),
  reserved_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE INDEX credit_reservations_user_idx ON credit_reservations(user_id, status);

-- Credit movements live beside their invariant. AFTER triggers run only when
-- an insert/update really wins, so concurrent idempotent requests cannot
-- increment the account twice. RAISE rolls the originating statement back.
CREATE TRIGGER credit_reservation_insert
AFTER INSERT ON credit_reservations
WHEN NEW.status = 'reserved'
BEGIN
  UPDATE credit_accounts
  SET reserved_credits = reserved_credits + NEW.credits,
      updated_at = NEW.reserved_at
  WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER credit_reservation_restore
AFTER UPDATE OF status ON credit_reservations
WHEN OLD.status = 'refunded' AND NEW.status = 'reserved'
BEGIN
  UPDATE credit_accounts
  SET reserved_credits = reserved_credits + NEW.credits,
      updated_at = NEW.reserved_at
  WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER credit_reservation_finalize
AFTER UPDATE OF status ON credit_reservations
WHEN OLD.status = 'reserved' AND NEW.status = 'finalized'
BEGIN
  UPDATE credit_accounts
  SET reserved_credits = reserved_credits - NEW.credits,
      spent_credits = spent_credits + NEW.credits,
      updated_at = NEW.settled_at
  WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER credit_reservation_refund
AFTER UPDATE OF status ON credit_reservations
WHEN OLD.status = 'reserved' AND NEW.status = 'refunded'
BEGIN
  UPDATE credit_accounts
  SET reserved_credits = reserved_credits - NEW.credits,
      updated_at = NEW.settled_at
  WHERE user_id = NEW.user_id;
END;

CREATE TABLE entitlements (
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  target_language TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, source_hash, target_language)
);

CREATE TABLE preview_claims (
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, source_hash)
);

CREATE TABLE rate_limits (
  subject TEXT NOT NULL,
  bucket TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL CHECK(count > 0),
  PRIMARY KEY(subject, bucket, window_start)
);

CREATE INDEX rate_limits_window_idx ON rate_limits(window_start);

CREATE TABLE security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX security_events_created_idx ON security_events(created_at);
