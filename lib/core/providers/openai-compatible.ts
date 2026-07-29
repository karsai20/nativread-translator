// Provider adapter for OpenAI-compatible Chat Completions endpoints.
//
// This covers OpenAI directly and providers that intentionally expose the same
// /chat/completions shape. Providers with different semantics, such as Anthropic's
// Messages API, should get their own adapter behind the same Translator interface.

import type { GlossaryMap } from "../glossary";
import type {
  Translator,
  TranslateChunkInput,
  TranslateChunkOutput,
  RefineChunkInput,
  EstimateChunkInput,
  EstimateChunkOutput,
  FillGlossaryInput,
  FillGlossaryOutput,
} from "../translator";
import { fetchWithRetry } from "./http";
import {
  diagnosisInstruction,
  estimateSystemPrompt,
  glossarySystemPrompt,
  literarySystemPrompt,
  refineSystemPrompt,
  withContext,
} from "./prompts";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const MAX_OUTPUT_TOKENS = 8192;
const TEMPERATURE = 0.5;
// The verdict is ~30 tokens of JSON. The headroom is there so a model that spends
// hidden reasoning tokens against the same budget still has room to emit the JSON —
// a truncated verdict parses as "no verdict" and silently disables the refine gate.
const ESTIMATE_MAX_TOKENS = 256;
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
  /**
   * OpenAI-style `reasoning_effort`, sent on every call EXCEPT the reasoner model
   * (where thinking is the point). Gemini 2.5 models think at "medium" by default and
   * bill thought tokens at the output rate, so "none" is a large, quality-neutral
   * saving for straight translation. Left unset the provider default applies.
   */
  reasoningEffort?: string;
  /** Sampling temperature for draft/refine calls. The judge always runs at 0. */
  temperature?: number;
  /**
   * Provider-specific thinking configuration, merged as top-level body keys (Gemini 3.x
   * has no OpenAI-schema slot for it). Like reasoningEffort it is skipped for the reasoner
   * model. The caller owns the wire shape — see `bun run eval:probe`.
   */
  thinkingBody?: Record<string, unknown>;
  mapCachedInputTokens?: (usage: Record<string, unknown> | undefined) => number;
}

/**
 * Cache-hit input tokens. OpenAI reports usage.prompt_tokens_details.cached_tokens; the
 * Gemini compatibility layer is beta and has been seen passing the native field name
 * through instead, so accept both — the wrong guess would silently price cache hits at
 * the full rate.
 */
function defaultCachedTokens(usage: Record<string, unknown> | undefined): number {
  const details = usage?.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  if (typeof details?.cached_tokens === "number") return details.cached_tokens;
  if (typeof usage?.total_cached_tokens === "number") return usage.total_cached_tokens;
  return 0;
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
  private readonly reasoningEffort?: string;
  private readonly temperature: number;
  private readonly thinkingBody?: Record<string, unknown>;
  private readonly mapCachedInputTokens: (usage: Record<string, unknown> | undefined) => number;

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
    if (opts.reasoningEffort) this.reasoningEffort = opts.reasoningEffort;
    this.temperature = opts.temperature ?? TEMPERATURE;
    if (opts.thinkingBody) this.thinkingBody = opts.thinkingBody;
    this.mapCachedInputTokens = opts.mapCachedInputTokens ?? defaultCachedTokens;
  }

  private async chat(
    system: string,
    user: string,
    opts: { temperature?: number; maxTokens?: number; model?: string; responseFormat?: "json_object" } = {},
  ): Promise<TranslateChunkOutput> {
    const model = opts.model ?? this.model;
    // The reasoner model is escalated to precisely for its thinking — never suppress it there.
    const isReasoner = model === this.reasonerModel;
    const body: Record<string, unknown> = {
      ...(isReasoner ? {} : this.thinkingBody),
      model,
      temperature: opts.temperature ?? this.temperature,
      max_tokens: opts.maxTokens ?? MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    if (opts.responseFormat) body.response_format = { type: opts.responseFormat };
    if (this.reasoningEffort && !isReasoner) body.reasoning_effort = this.reasoningEffort;

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
        cachedInputTokens: this.mapCachedInputTokens(usage),
      },
    };
  }

  translateChunk(input: TranslateChunkInput): Promise<TranslateChunkOutput> {
    const system = literarySystemPrompt(input.targetLang, input.glossary);
    const user = withContext(input.text, input.previousContext, input.sourceContext);
    return this.chat(system, user, input.deterministic ? { temperature: 0 } : {});
  }

  refineChunk(input: RefineChunkInput): Promise<TranslateChunkOutput> {
    const system = refineSystemPrompt(input.targetLang, input.glossary);
    const body =
      `${diagnosisInstruction(input.diagnosis)}Source (for reference only):\n${input.source}\n\n` +
      `Draft to improve:\n${input.draft}`;
    const model = input.deep && this.reasonerModel ? this.reasonerModel : undefined;
    return this.chat(system, withContext(body, input.previousContext), model ? { model } : {});
  }

  async fillGlossary(input: FillGlossaryInput): Promise<FillGlossaryOutput> {
    const out = await this.chat(
      glossarySystemPrompt(input.targetLang),
      input.terms.map((t) => `- ${t}`).join("\n"),
      { temperature: 0, responseFormat: "json_object" },
    );

    const glossary: GlossaryMap = {};
    try {
      const parsed = JSON.parse(out.text) as Record<string, unknown>;
      const known = new Set(input.terms);
      for (const [term, rendering] of Object.entries(parsed)) {
        // Ignore hallucinated keys: a term we never asked about would silently enter the
        // prompt of every chunk for the rest of the book.
        if (known.has(term) && typeof rendering === "string" && rendering.trim()) {
          glossary[term] = rendering.trim();
        }
      }
    } catch {
      console.error(JSON.stringify({ event: "glossary-fill-unparseable", provider: this.name }));
    }

    return { glossary, usage: out.usage };
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
    let weakBlocks: number[] | undefined;
    try {
      const v = JSON.parse(out.text) as Partial<{
        score: number;
        omission: boolean;
        accuracy: boolean;
        fluency: boolean;
        weak_blocks: unknown;
      }>;
      if (typeof v.score === "number") score = Math.max(1, Math.min(5, Math.round(v.score)));
      omission = Boolean(v.omission);
      accuracy = Boolean(v.accuracy);
      fluency = Boolean(v.fluency);
      if (Array.isArray(v.weak_blocks)) {
        const indices = v.weak_blocks.filter(
          (n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0,
        );
        if (indices.length > 0) weakBlocks = indices;
      }
    } catch {
      // A verdict we cannot parse means no quality gate ran for this chunk — the
      // refine pass silently stops firing. Loud enough to notice in the job log.
      console.error(JSON.stringify({
        event: "estimate-verdict-unparseable",
        provider: this.name,
        sample: out.text.slice(0, 120),
      }));
      score = undefined;
    }

    const needsRefine =
      score === undefined ? true : score <= REFINE_SCORE_THRESHOLD || omission || accuracy;
    const hard = score !== undefined && score <= HARD_SCORE_THRESHOLD;
    return {
      needsRefine,
      hard,
      score,
      omission,
      accuracy,
      fluency,
      ...(weakBlocks ? { weakBlocks } : {}),
      usage: out.usage,
    };
  }
}
