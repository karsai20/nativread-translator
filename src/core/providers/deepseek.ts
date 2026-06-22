// DeepSeek provider adapter (OpenAI-compatible chat completions API).
//
// Behind the same Translator interface as the fake, so the rest of the pipeline never
// changes. The key comes only from configuration (env -> .env); it is never logged.

import type {
  Translator,
  TranslateChunkInput,
  TranslateChunkOutput,
} from "../translator.ts";
import { formatForPrompt } from "../glossary.ts";
import { PLACEHOLDER_OPEN, PLACEHOLDER_CLOSE } from "../markup.ts";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

export interface DeepSeekOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

function systemPrompt(input: TranslateChunkInput): string {
  const glossaryBlock = formatForPrompt(input.glossary);
  return [
    `You are a literary translator. Translate the user's text from ${input.sourceLang} ` +
      `to ${input.targetLang}.`,
    "Rules:",
    `- Output ONLY the translation. No notes, no quotes around it, no explanations.`,
    `- The text contains placeholder tokens of the form ${PLACEHOLDER_OPEN}N${PLACEHOLDER_CLOSE} ` +
      `(where N is a number). These represent inline formatting. Keep every token EXACTLY ` +
      `as-is, in the same relative position. Never translate, renumber, add, or drop a token.`,
    `- Preserve paragraph breaks. Produce natural, fluent ${input.targetLang} a native ` +
      `reader would enjoy — not a literal word-for-word rendering.`,
    glossaryBlock,
  ]
    .filter(Boolean)
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

  async translateChunk(input: TranslateChunkInput): Promise<TranslateChunkOutput> {
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 1.3, // DeepSeek's recommended value for translation/creative text
        messages: [
          { role: "system", content: systemPrompt(input) },
          { role: "user", content: input.text },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `DeepSeek request failed: ${res.status} ${res.statusText} ${detail.slice(0, 500)}`,
      );
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error("DeepSeek response missing message content.");
    }

    return {
      text,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }
}
