import type { TranslatorContainer } from "./container";

export type JobStatus =
  | "pending"
  | "queued"
  | "starting"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export interface JobRow {
  id: string;
  user_id: string;
  status: JobStatus;
  source_key: string;
  result_key: string | null;
  workflow_instance_id: string | null;
  provider: string;
  target_language: string;
  sample: number;
  source_hash: string;
  title: string | null;
  spine_item_count: number;
  source_characters: number;
  required_credits: number;
  quote_version: string;
  terms_version: string | null;
  ai_consent_version: string | null;
  ai_provider: string | null;
  translated_chunks: number;
  total_chunks: number;
  error_code: string | null;
  error_message: string | null;
  cost_usd: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  delivered_at: string | null;
  expires_at: string;
}

export interface TranslationMessage {
  jobId: string;
}

export interface TranslationWorkflowParams {
  jobId: string;
}

export interface ContainerResultMetadata {
  status: "done" | "error" | "cancelled";
  title?: string;
  totalChunks: number;
  translatedChunks: number;
  costUsd: number;
  errorCode?: string;
}

export interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  TRANSLATION_QUEUE: Queue<TranslationMessage>;
  TRANSLATION_WORKFLOW: Workflow<TranslationWorkflowParams>;
  TRANSLATOR_CONTAINER: DurableObjectNamespace<TranslatorContainer>;

  ENVIRONMENT: string;
  PROVIDER_NAME: string;
  PROVIDER_MODEL: string;
  PROVIDER_BASE_URL: string;
  TERMS_VERSION: string;
  TERMS_EFFECTIVE_AT: string;
  TERMS_DOCUMENT_URL: string;
  RIGHTS_ATTESTATION_VERSION: string;
  AI_CONSENT_VERSION: string;
  AI_PROVIDER_DISCLOSURE: string;
  MAX_EPUB_UPLOAD_BYTES: string;
  MAX_EPUB_UNCOMPRESSED_BYTES: string;
  MAX_EPUB_ENTRIES: string;
  MAX_ACTIVE_TRANSLATIONS: string;
  GLOBAL_DAILY_AI_BUDGET_USD: string;
  GLOBAL_MONTHLY_AI_BUDGET_USD: string;
  ARTIFACT_RETENTION_HOURS: string;
  TRANSLATION_CONCURRENCY: string;
  TRANSLATION_REFINE: string;
  TRANSLATION_REFINE_SELECTIVE: string;
  TRANSLATION_REASONER_HARD: string;
  TRANSLATION_PRECISION: string;
  COST_CEILING_USD: string;
  REQUIRE_TRANSLATION_ENTITLEMENTS: string;
  ALLOW_DEV_AUTH: string;

  APPLE_CLIENT_IDS: string;
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;
  APPLE_PRIVATE_KEY: string;
  SESSION_SECRET: string;
  GEMINI_API_KEY: string;
  CONTAINER_INTERNAL_TOKEN: string;
}
