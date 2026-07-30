-- Per-book App Store purchases. The transaction id is the primary key, so a
-- replayed receipt is a no-op instead of a second entitlement, and the trigger
-- keeps the grant beside the purchase that justifies it (same idiom as the
-- credit movements in 0001).
CREATE TABLE book_purchases (
  transaction_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK(length(source_hash) = 64),
  target_language TEXT NOT NULL CHECK(length(target_language) BETWEEN 2 AND 8),
  environment TEXT NOT NULL CHECK(environment IN ('Production', 'Sandbox')),
  created_at TEXT NOT NULL
);

CREATE INDEX book_purchases_user_idx ON book_purchases(user_id, created_at DESC);

CREATE TRIGGER book_purchase_entitles
AFTER INSERT ON book_purchases
BEGIN
  INSERT OR IGNORE INTO entitlements (user_id, source_hash, target_language, created_at)
  VALUES (NEW.user_id, NEW.source_hash, NEW.target_language, NEW.created_at);
END;
