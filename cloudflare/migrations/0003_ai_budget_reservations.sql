CREATE TABLE ai_budget_reservations (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  budget_day TEXT NOT NULL CHECK(length(budget_day) = 10),
  reserved_cents INTEGER NOT NULL CHECK(reserved_cents > 0),
  actual_cents INTEGER NOT NULL DEFAULT 0 CHECK(actual_cents >= 0),
  status TEXT NOT NULL CHECK(status IN ('reserved', 'finalized', 'refunded')),
  created_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE INDEX ai_budget_day_status_idx
ON ai_budget_reservations(budget_day, status);
