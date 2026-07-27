CREATE TABLE terms_acceptances (
  acceptance_id TEXT PRIMARY KEY CHECK(length(acceptance_id) = 36),
  user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL CHECK(length(source_hash) = 64),
  terms_version TEXT NOT NULL,
  statement_version TEXT NOT NULL,
  acceptance_method TEXT NOT NULL CHECK(acceptance_method = 'ios-clickwrap'),
  client_accepted_at TEXT NOT NULL,
  server_accepted_at TEXT NOT NULL,
  locale TEXT NOT NULL CHECK(length(locale) BETWEEN 2 AND 35),
  terms_document_url TEXT NOT NULL CHECK(terms_document_url LIKE 'https://%')
);

CREATE UNIQUE INDEX terms_acceptances_scope_idx
ON terms_acceptances(user_id, source_hash, terms_version);

CREATE INDEX terms_acceptances_user_time_idx
ON terms_acceptances(user_id, server_accepted_at DESC);
