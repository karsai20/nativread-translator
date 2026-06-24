// DeepSeek provider adapter (OpenAI-compatible chat completions API).
//
// All the quality lives in the prompts. We are constrained to DeepSeek, so the system
// prompt does the heavy lifting: it asks for natural, fluent *literary* Hungarian a
// native reader enjoys (not literal translationese), with consistent register/formality,
// carried glossary, and exact preservation of the inline tokens + block markers. A
// preceding-context snippet keeps voice continuous across chunk seams. The optional
// refine pass asks the model to improve its own draft.

import type {
  Translator,
  TranslateChunkInput,
  TranslateChunkOutput,
  RefineChunkInput,
  EstimateChunkInput,
  EstimateChunkOutput,
} from "../translator";
import { formatForPrompt } from "../glossary";
import { PLACEHOLDER_OPEN, PLACEHOLDER_CLOSE, BLOCK_MARKER_OPEN, BLOCK_MARKER_CLOSE } from "../markup";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
// Pin the concrete model: the `deepseek-chat` alias is deprecated on 2026-07-24.
// deepseek-v4-flash is its non-thinking successor (cheapest frontier-class tier).
const DEEPSEEK_MODEL = "deepseek-v4-flash";
// Thinking mode of the same family, used to refine only the hardest passages.
const DEEPSEEK_REASONER_MODEL = "deepseek-reasoner";
const MAX_OUTPUT_TOKENS = 8192;
// DeepSeek's own recommendation for translation / creative writing.
const TEMPERATURE = 1.3;
// The quality gate returns a single digit, so cap output hard and grade deterministically.
const ESTIMATE_MAX_TOKENS = 8;
const ESTIMATE_TEMPERATURE = 0;
// Drafts scoring at or below this (1–5) get the refine pass; 4–5 are kept as-is.
const REFINE_SCORE_THRESHOLD = 3;
// The weakest drafts (score at or below this) are refined on the reasoning model.
const HARD_SCORE_THRESHOLD = 2;

export interface DeepSeekOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

const TOKEN_DESC =
  `placeholder tokens of the form ${PLACEHOLDER_OPEN}N${PLACEHOLDER_CLOSE} (inline formatting) ` +
  `and block markers of the form ${BLOCK_MARKER_OPEN}N${BLOCK_MARKER_CLOSE} (paragraph boundaries)`;

const PRESERVE_RULES = [
  `- The text contains ${TOKEN_DESC}. Keep EVERY token and marker EXACTLY as-is, with`,
  `  the same numbers, in the same positions. Never translate, renumber, merge, drop, or`,
  `  add one. Each block marker must appear once, before the paragraph it introduces.`,
];

// IMPORTANT: keep these system prompts byte-identical across every chunk of a book so
// DeepSeek serves them from its context cache (cache-hit input is ~50x cheaper than a
// miss, and a cached prefix also lowers latency). That means NO per-chunk content here:
// the rolling continuity tail lives in the user message instead (see withContext). The
// glossary is stable for a whole book, so it stays in the cached prefix.
const CONTEXT_INSTRUCTION =
  `- If the user message starts with a "PRECEDING CONTEXT" block, use it ONLY to keep ` +
  `voice, register, and formality continuous. Never translate, repeat, or output it.`;

function literarySystemPrompt(targetLang: string, glossary: string): string {
  return [
    `You are an award-winning literary translator translating a book into ${targetLang}.`,
    ``,
    `Translate so it reads as natural, fluent, idiomatic ${targetLang} that a native`,
    `reader enjoys — NOT a literal, word-for-word rendering. Specifically:`,
    `- Use natural ${targetLang} word order, idiom, and rhythm; rephrase freely as long`,
    `  as the meaning, tone, and intent are preserved. Avoid translationese and calques.`,
    `- Preserve the author's voice, register, humour, and emotional colour.`,
    `- Choose the appropriate level of formality for each relationship in dialogue and`,
    `  keep it consistent (in Hungarian: te / ön / maga). Narration stays in natural,`,
    `  consistent register.`,
    `- Keep paragraph structure: one source paragraph -> one translated paragraph.`,
    ...PRESERVE_RULES,
    CONTEXT_INSTRUCTION,
    `- Output ONLY the translation (with the markers/tokens). No notes, no commentary,`,
    `  no quotes around it.`,
    glossary ? `\n${glossary}` : ``,
  ]
    .filter((l) => l !== ``)
    .join("\n");
}

function refineSystemPrompt(targetLang: string, glossary: string): string {
  return [
    `You are a meticulous ${targetLang} literary editor. You are given an ${targetLang}`,
    `draft translation. Improve it so it reads as polished, natural, fluent ${targetLang}`,
    `prose a native reader would enjoy:`,
    `- Fix awkward phrasing, unnatural word order, calques, and translationese.`,
    `- Smooth rhythm and flow; make dialogue sound like real spoken ${targetLang}.`,
    `- Keep meaning, tone, register, and formality consistent.`,
    ...PRESERVE_RULES,
    CONTEXT_INSTRUCTION,
    `- Output ONLY the improved ${targetLang} text (with the same markers/tokens).`,
    glossary ? `\n${glossary}` : ``,
  ]
    .filter((l) => l !== ``)
    .join("\n");
}

/** Prepend the rolling continuity tail (the only per-chunk content) to the user text. */
function withContext(text: string, prev?: string): string {
  if (!prev) return text;
  return `PRECEDING CONTEXT (for continuity only, do not translate):\n"""${prev}"""\n\nTEXT TO TRANSLATE:\n${text}`;
}

function estimateSystemPrompt(targetLang: string, glossary: string): string {
  return [
    `You are a strict literary translation quality grader for ${targetLang}.`,
    `You are given a SOURCE passage and a DRAFT ${targetLang} translation.`,
    `Rate the DRAFT's quality as a single integer from 1 to 5:`,
    `  5 = publishable literary ${targetLang}, idiomatic and accurate, needs no edits.`,
    `  4 = good, only trivial nits.`,
    `  3 = noticeable awkwardness, calques, or minor inaccuracy — worth an editing pass.`,
    `  2 = clumsy or partly literal; clearly needs revision.`,
    `  1 = inaccurate, broken, or contains untranslated/garbled text.`,
    `Judge fluency, naturalness, accuracy, and consistency with the glossary.`,
    `Reply with ONLY the single digit (1–5). No words, no punctuation.`,
    glossary ? `\n${glossary}` : ``,
  ]
    .filter((l) => l !== ``)
    .join("\n");
}

export class DeepSeekTranslator implements Translator {
  readonly name = "deepseek";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: DeepSeekOptions) {
    if (!opts.apiKey) throw new Error("DeepSeekTranslator requires an API key.");
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEEPSEEK_MODEL;
    this.baseUrl = opts.baseUrl ?? DEEPSEEK_URL;
  }

  private async chat(
    system: string,
    user: string,
    opts: { temperature?: number; maxTokens?: number; model?: string } = {},
  ): Promise<TranslateChunkOutput> {
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: opts.model ?? this.model,
        temperature: opts.temperature ?? TEMPERATURE,
        max_tokens: opts.maxTokens ?? MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`DeepSeek request failed: ${res.status} ${res.statusText} ${detail.slice(0, 500)}`);
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        // DeepSeek reports how much of prompt_tokens was a cache hit (billed cheaper).
        prompt_cache_hit_tokens?: number;
      };
    };
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("DeepSeek response missing message content.");

    return {
      text,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        cachedInputTokens: json.usage?.prompt_cache_hit_tokens ?? 0,
      },
    };
  }

  translateChunk(input: TranslateChunkInput): Promise<TranslateChunkOutput> {
    const system = literarySystemPrompt(input.targetLang, formatForPrompt(input.glossary));
    return this.chat(system, withContext(input.text, input.previousContext));
  }

  refineChunk(input: RefineChunkInput): Promise<TranslateChunkOutput> {
    const system = refineSystemPrompt(input.targetLang, formatForPrompt(input.glossary));
    const body = `Source (for reference only):\n${input.source}\n\nDraft to improve:\n${input.draft}`;
    // The hardest passages get the reasoning model; everything else stays on flash.
    return this.chat(system, withContext(body, input.previousContext), input.deep ? { model: DEEPSEEK_REASONER_MODEL } : {});
  }

  async estimateChunk(input: EstimateChunkInput): Promise<EstimateChunkOutput> {
    const system = estimateSystemPrompt(input.targetLang, formatForPrompt(input.glossary));
    const user = `SOURCE:\n${input.source}\n\nDRAFT:\n${input.draft}`;
    const out = await this.chat(system, user, {
      temperature: ESTIMATE_TEMPERATURE,
      maxTokens: ESTIMATE_MAX_TOKENS,
    });
    const digit = out.text.match(/[1-5]/)?.[0];
    const score = digit ? Number(digit) : undefined;
    // No parseable score -> refine (conservative: don't drop polish on a parse hiccup).
    const needsRefine = score === undefined ? true : score <= REFINE_SCORE_THRESHOLD;
    const hard = score !== undefined && score <= HARD_SCORE_THRESHOLD;
    return { needsRefine, hard, score, usage: out.usage };
  }
}
