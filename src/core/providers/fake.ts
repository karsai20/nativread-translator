// Fake provider: deterministic, no network egress, no cost.
//
// It drives the entire test suite and lets the whole app run end-to-end without an API
// key. Contract it must honor (same as any real provider):
//   - Every placeholder token (⟦n⟧) in the input survives verbatim in the output.
//   - Output is a pure function of input (deterministic) so tests can assert it.
//   - Glossary terms present in the input are echoed using their target rendering
//     when one is given, proving glossary plumbing works.

import type {
  Translator,
  TranslateChunkInput,
  TranslateChunkOutput,
} from "../translator.ts";
import { PLACEHOLDER_OPEN, PLACEHOLDER_CLOSE } from "../markup.ts";
import { estimateTokens } from "../cost.ts";

// Marks translated text so tests (and a human eyeballing the fake run) can see the
// pipeline ran, without disturbing tokens.
export const FAKE_PREFIX = "⟪hu⟫ ";

const tokenRe = new RegExp(`${PLACEHOLDER_OPEN}\\d+${PLACEHOLDER_CLOSE}`);

function isToken(word: string): boolean {
  return tokenRe.test(word);
}

export class FakeTranslator implements Translator {
  readonly name = "fake";

  async translateChunk(input: TranslateChunkInput): Promise<TranslateChunkOutput> {
    let text = input.text;

    // Apply any glossary target renderings so glossary plumbing is observable.
    for (const [term, target] of Object.entries(input.glossary)) {
      if (target) text = text.split(term).join(target);
    }

    // "Translate" deterministically: uppercase alphabetic words, leave tokens and
    // punctuation alone. Tokens pass through untouched.
    const translated = text.replace(/\S+/g, (word) =>
      isToken(word) ? word : word.toUpperCase(),
    );

    const out = FAKE_PREFIX + translated;
    return {
      text: out,
      usage: {
        inputTokens: estimateTokens(input.text),
        outputTokens: estimateTokens(out),
      },
    };
  }
}
