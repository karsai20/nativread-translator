-- Jobs recorded only where a translation was going, never where it came from,
-- because the pipeline assumed English. The pair is now data, so the source
-- side has to be stored alongside the target for the runner to read back.
ALTER TABLE jobs ADD COLUMN source_language TEXT NOT NULL DEFAULT 'en'
  CHECK(length(source_language) BETWEEN 2 AND 8);
