// Backward-compatible DeepSeek preset over the generic OpenAI-compatible adapter.

import { OpenAICompatibleTranslator, type OpenAICompatibleOptions } from "./openai-compatible";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEEPSEEK_REASONER_MODEL = "deepseek-reasoner";

export interface DeepSeekOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

function deepSeekCachedTokens(usage: Record<string, unknown> | undefined): number {
  return typeof usage?.prompt_cache_hit_tokens === "number" ? usage.prompt_cache_hit_tokens : 0;
}

export class DeepSeekTranslator extends OpenAICompatibleTranslator {
  constructor(opts: DeepSeekOptions) {
    const adapterOpts: OpenAICompatibleOptions = {
      name: "deepseek",
      apiKey: opts.apiKey,
      model: opts.model ?? DEEPSEEK_MODEL,
      baseUrl: opts.baseUrl ?? DEEPSEEK_URL,
      reasonerModel: DEEPSEEK_REASONER_MODEL,
      fetchImpl: opts.fetchImpl,
      mapCachedInputTokens: deepSeekCachedTokens,
    };
    super(adapterOpts);
  }
}
