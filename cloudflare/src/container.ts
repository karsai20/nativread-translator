import { Container } from "@cloudflare/containers";

import type { Env } from "./types";

/**
 * One stable container instance is addressed by each job UUID. The container
 * receives no R2/D1 credentials and can only reach Gemini over the internet.
 */
export class TranslatorContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = true;
  interceptHttps = true;
  allowedHosts = ["generativelanguage.googleapis.com"];
  envVars = {
    NODE_ENV: "production",
    TRANSLATION_PROVIDER: this.env.PROVIDER_NAME,
    PROVIDER_MODEL: this.env.PROVIDER_MODEL,
    PROVIDER_BASE_URL: this.env.PROVIDER_BASE_URL,
    GEMINI_API_KEY: this.env.GEMINI_API_KEY,
    CONTAINER_INTERNAL_TOKEN: this.env.CONTAINER_INTERNAL_TOKEN,
    MAX_EPUB_UPLOAD_BYTES: this.env.MAX_EPUB_UPLOAD_BYTES,
    MAX_EPUB_UNCOMPRESSED_BYTES: this.env.MAX_EPUB_UNCOMPRESSED_BYTES,
    MAX_EPUB_ENTRIES: this.env.MAX_EPUB_ENTRIES,
    TRANSLATION_CONCURRENCY: this.env.TRANSLATION_CONCURRENCY,
    TRANSLATION_REFINE: this.env.TRANSLATION_REFINE,
    TRANSLATION_REFINE_SELECTIVE: this.env.TRANSLATION_REFINE_SELECTIVE,
    TRANSLATION_REASONER_HARD: this.env.TRANSLATION_REASONER_HARD,
    TRANSLATION_PRECISION: this.env.TRANSLATION_PRECISION,
    COST_CEILING_USD: this.env.COST_CEILING_USD,
    NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  };
}
