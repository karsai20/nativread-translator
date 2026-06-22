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
  ResolveGlossaryInput,
} from "../translator";
import { formatForPrompt, parseGlossaryResolution, type GlossaryMap } from "../glossary";
import { PLACEHOLDER_OPEN, PLACEHOLDER_CLOSE, BLOCK_MARKER_OPEN, BLOCK_MARKER_CLOSE } from "../markup";
import { withRetry, RetryableError, parseRetryAfterMs } from "../retry";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";
const MAX_OUTPUT_TOKENS = 8192;
// DeepSeek's own recommendation for translation / creative writing.
const TEMPERATURE = 1.3;
// Glossary resolution is a list task, not creative — keep it tight and deterministic.
const RESOLVE_TEMPERATURE = 0.2;

export interface DeepSeekOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Retries after the first attempt for transient failures (default 4). */
  retries?: number;
  /** Per-request timeout in ms (default 120s). */
  timeoutMs?: number;
}

const TOKEN_DESC =
  `placeholder tokens of the form ${PLACEHOLDER_OPEN}N${PLACEHOLDER_CLOSE} (inline formatting) ` +
  `and block markers of the form ${BLOCK_MARKER_OPEN}N${BLOCK_MARKER_CLOSE} (paragraph boundaries)`;

const PRESERVE_RULES = [
  `- The text contains ${TOKEN_DESC}. Keep EVERY token and marker EXACTLY as-is, with`,
  `  the same numbers, in the same positions. Never translate, renumber, merge, drop, or`,
  `  add one. Each block marker must appear once, before the paragraph it introduces.`,
];

function literarySystemPrompt(targetLang: string, glossary: string, prev?: string): string {
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
    `- Output ONLY the translation (with the markers/tokens). No notes, no commentary,`,
    `  no quotes around it.`,
    prev ? `\nThe immediately preceding translated text (continue seamlessly in the same\nvoice and register; do NOT re-translate it):\n"""${prev}"""` : ``,
    glossary ? `\n${glossary}` : ``,
  ]
    .filter((l) => l !== ``)
    .join("\n");
}

function refineSystemPrompt(targetLang: string, glossary: string, prev?: string): string {
  return [
    `You are a meticulous ${targetLang} literary editor. You are given an ${targetLang}`,
    `draft translation. Improve it so it reads as polished, natural, fluent ${targetLang}`,
    `prose a native reader would enjoy:`,
    `- Fix awkward phrasing, unnatural word order, calques, and translationese.`,
    `- Smooth rhythm and flow; make dialogue sound like real spoken ${targetLang}.`,
    `- Keep meaning, tone, register, and formality consistent.`,
    ...PRESERVE_RULES,
    `- Output ONLY the improved ${targetLang} text (with the same markers/tokens).`,
    prev ? `\nPreceding translated text for continuity:\n"""${prev}"""` : ``,
    glossary ? `\n${glossary}` : ``,
  ]
    .filter((l) => l !== ``)
    .join("\n");
}

function resolveSystemPrompt(targetLang: string): string {
  return [
    `You are preparing to translate a book into ${targetLang}. For each English name or`,
    `term below, decide the SINGLE canonical ${targetLang} rendering you will use every`,
    `time it appears, so it stays identical across the whole book. Give the base form`,
    `(it will be declined naturally in context later). For names that should stay`,
    `unchanged, repeat them unchanged.`,
    `Output one line per term, exactly: term -> rendering`,
    `No numbering, no commentary, no extra lines.`,
  ].join("\n");
}

export class DeepSeekTranslator implements Translator {
  readonly name = "deepseek";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly retries: number;
  private readonly timeoutMs: number;

  constructor(opts: DeepSeekOptions) {
    if (!opts.apiKey) throw new Error("DeepSeekTranslator requires an API key.");
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEEPSEEK_MODEL;
    this.baseUrl = opts.baseUrl ?? DEEPSEEK_URL;
    this.retries = opts.retries ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  private async chat(
    system: string,
    user: string,
    temperature: number = TEMPERATURE,
  ): Promise<TranslateChunkOutput> {
    return withRetry(
      async (signal) => {
        const res = await fetch(this.baseUrl, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            temperature,
            max_tokens: MAX_OUTPUT_TOKENS,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
          }),
          signal,
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          const message = `DeepSeek request failed: ${res.status} ${res.statusText} ${detail.slice(0, 300)}`;
          // 429 and 5xx are transient — back off and retry. Other 4xx fail fast.
          if (res.status === 429 || res.status >= 500) {
            throw new RetryableError(message, parseRetryAfterMs(res.headers.get("retry-after")));
          }
          throw new Error(message);
        }

        const json = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const text = json.choices?.[0]?.message?.content;
        if (typeof text !== "string") throw new Error("DeepSeek response missing message content.");

        return {
          text,
          usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
        };
      },
      { retries: this.retries, timeoutMs: this.timeoutMs },
    );
  }

  translateChunk(input: TranslateChunkInput): Promise<TranslateChunkOutput> {
    const system = literarySystemPrompt(input.targetLang, formatForPrompt(input.glossary), input.previousContext);
    return this.chat(system, input.text);
  }

  refineChunk(input: RefineChunkInput): Promise<TranslateChunkOutput> {
    const system = refineSystemPrompt(input.targetLang, formatForPrompt(input.glossary), input.previousContext);
    const user = `Source (for reference only):\n${input.source}\n\nDraft to improve:\n${input.draft}`;
    return this.chat(system, user);
  }

  async resolveGlossary(input: ResolveGlossaryInput): Promise<GlossaryMap> {
    if (input.terms.length === 0) return {};
    const user = input.terms.join("\n");
    const { text } = await this.chat(resolveSystemPrompt(input.targetLang), user, RESOLVE_TEMPERATURE);
    return parseGlossaryResolution(text, input.terms);
  }
}
