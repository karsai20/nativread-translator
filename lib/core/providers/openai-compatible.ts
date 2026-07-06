// Provider adapter for OpenAI-compatible Chat Completions endpoints.
//
// This covers OpenAI directly and providers that intentionally expose the same
// /chat/completions shape. Providers with different semantics, such as Anthropic's
// Messages API, should get their own adapter behind the same Translator interface.

import type {
  Translator,
  TranslateChunkInput,
  TranslateChunkOutput,
  RefineChunkInput,
  EstimateChunkInput,
  EstimateChunkOutput,
} from "../translator";
import { fetchWithRetry } from "./http";
import {
  estimateSystemPrompt,
  literarySystemPrompt,
  refineSystemPrompt,
  withContext,
} from "./prompts";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const MAX_OUTPUT_TOKENS = 8192;
const TEMPERATURE = 0.5;
const ESTIMATE_MAX_TOKENS = 64;
const ESTIMATE_TEMPERATURE = 0;
const REFINE_SCORE_THRESHOLD = 3;
const HARD_SCORE_THRESHOLD = 2;

export interface OpenAICompatibleOptions {
  apiKey: string;
  model: string;
  name?: string;
  baseUrl?: string;
  reasonerModel?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  reasonerTimeoutMs?: number;
  mapCachedInputTokens?: (usage: Record<string, unknown> | undefined) => number;
}

export class OpenAICompatibleTranslator implements Translator {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly reasonerModel?: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private readonly reasonerTimeoutMs: number;
  private readonly mapCachedInputTokens?: (usage: Record<string, unknown> | undefined) => number;

  constructor(opts: OpenAICompatibleOptions) {
    if (!opts.apiKey) throw new Error("OpenAICompatibleTranslator requires an API key.");
    if (!opts.model) throw new Error("OpenAICompatibleTranslator requires a model.");
    this.name = opts.name ?? "openai";
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl ?? OPENAI_CHAT_URL;
    this.reasonerModel = opts.reasonerModel;
    this.fetchImpl = opts.fetchImpl;
    this.timeoutMs = opts.timeoutMs ?? 120000;
    this.reasonerTimeoutMs = opts.reasonerTimeoutMs ?? 300000;
    this.mapCachedInputTokens = opts.mapCachedInputTokens;
  }

  private async chat(
    system: string,
    user: string,
    opts: { temperature?: number; maxTokens?: number; model?: string; responseFormat?: "json_object" } = {},
  ): Promise<TranslateChunkOutput> {
    const model = opts.model ?? this.model;
    const body: Record<string, unknown> = {
      model,
      temperature: opts.temperature ?? TEMPERATURE,
      max_tokens: opts.maxTokens ?? MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    if (opts.responseFormat) body.response_format = { type: opts.responseFormat };

    const res = await fetchWithRetry(
      this.baseUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      },
      {
        fetchImpl: this.fetchImpl,
        timeoutMs: model === this.reasonerModel ? this.reasonerTimeoutMs : this.timeoutMs,
      },
    );

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: Record<string, unknown>;
    };
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error(`${this.name} response missing message content.`);

    const usage = json.usage;
    const inputTokens =
      typeof usage?.prompt_tokens === "number"
        ? usage.prompt_tokens
        : typeof usage?.input_tokens === "number"
          ? usage.input_tokens
          : 0;
    const outputTokens =
      typeof usage?.completion_tokens === "number"
        ? usage.completion_tokens
        : typeof usage?.output_tokens === "number"
          ? usage.output_tokens
          : 0;

    return {
      text,
      usage: {
        inputTokens,
        outputTokens,
        cachedInputTokens: this.mapCachedInputTokens?.(usage) ?? 0,
      },
    };
  }

  translateChunk(input: TranslateChunkInput): Promise<TranslateChunkOutput> {
    const system = literarySystemPrompt(input.targetLang, input.glossary);
    return this.chat(system, withContext(input.text, input.previousContext), input.deterministic ? { temperature: 0 } : {});
  }

  refineChunk(input: RefineChunkInput): Promise<TranslateChunkOutput> {
    const system = refineSystemPrompt(input.targetLang, input.glossary);
    const body = `Source (for reference only):\n${input.source}\n\nDraft to improve:\n${input.draft}`;
    const model = input.deep && this.reasonerModel ? this.reasonerModel : undefined;
    return this.chat(system, withContext(body, input.previousContext), model ? { model } : {});
  }

  async estimateChunk(input: EstimateChunkInput): Promise<EstimateChunkOutput> {
    const system = estimateSystemPrompt(input.targetLang, input.glossary);
    const user = `SOURCE:\n${input.source}\n\nDRAFT:\n${input.draft}`;
    const out = await this.chat(system, user, {
      temperature: ESTIMATE_TEMPERATURE,
      maxTokens: ESTIMATE_MAX_TOKENS,
      responseFormat: "json_object",
    });

    let score: number | undefined;
    let omission = false;
    let accuracy = false;
    let fluency = false;
    try {
      const v = JSON.parse(out.text) as Partial<{
        score: number;
        omission: boolean;
        accuracy: boolean;
        fluency: boolean;
      }>;
      if (typeof v.score === "number") score = Math.max(1, Math.min(5, Math.round(v.score)));
      omission = Boolean(v.omission);
      accuracy = Boolean(v.accuracy);
      fluency = Boolean(v.fluency);
    } catch {
      score = undefined;
    }

    const needsRefine =
      score === undefined ? true : score <= REFINE_SCORE_THRESHOLD || omission || accuracy;
    const hard = score !== undefined && score <= HARD_SCORE_THRESHOLD;
    return { needsRefine, hard, score, omission, accuracy, fluency, usage: out.usage };
  }
}
