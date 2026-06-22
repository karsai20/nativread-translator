// Fake provider: deterministic, no network egress, no cost. Drives tests and lets the
// whole app run end-to-end without a key. Contract it honors (like any real provider):
//   - Every inline token (n) AND block marker survives verbatim.
//   - Output is a pure function of input (deterministic).
//   - Glossary target renderings are applied so glossary plumbing is observable.

import type {
  Translator,
  TranslateChunkInput,
  TranslateChunkOutput,
  RefineChunkInput,
} from "../translator";
import { PLACEHOLDER_OPEN, PLACEHOLDER_CLOSE, BLOCK_MARKER_OPEN, BLOCK_MARKER_CLOSE } from "../markup";
import { estimateTokens } from "../cost";

export const FAKE_PREFIX = "hu ";
export const FAKE_REFINE_TAG = "+";

// A "word" that contains any marker/token PUA char is preserved untouched.
const PRESERVE_RE = new RegExp(`[${PLACEHOLDER_OPEN}${PLACEHOLDER_CLOSE}${BLOCK_MARKER_OPEN}${BLOCK_MARKER_CLOSE}]`);

const BLOCK_RE = new RegExp(`(${BLOCK_MARKER_OPEN}\\d+${BLOCK_MARKER_CLOSE})`, "g");

function fakeTranslate(text: string, glossary: Record<string, string>): string {
  let t = text;
  for (const [term, target] of Object.entries(glossary)) {
    if (target) t = t.split(term).join(target);
  }
  // Uppercase real words; leave anything carrying a marker/token char alone.
  return t.replace(/\S+/g, (w) => (PRESERVE_RE.test(w) ? w : w.toUpperCase()));
}

export class FakeTranslator implements Translator {
  readonly name = "fake";

  async translateChunk(input: TranslateChunkInput): Promise<TranslateChunkOutput> {
    const upper = fakeTranslate(input.text, input.glossary);
    // Mark each block segment so the prefix survives splitting; for a single-block
    // (fallback) payload with no marker, just prepend it.
    const out = BLOCK_RE.test(upper)
      ? upper.replace(BLOCK_RE, `$1 ${FAKE_PREFIX}`)
      : FAKE_PREFIX + upper;
    return {
      text: out,
      usage: { inputTokens: estimateTokens(input.text), outputTokens: estimateTokens(out) },
    };
  }

  async refineChunk(input: RefineChunkInput): Promise<TranslateChunkOutput> {
    // Deterministic "polish": tag every block so tests can see the refine pass ran.
    const out = input.draft.replaceAll(FAKE_PREFIX, FAKE_PREFIX + FAKE_REFINE_TAG + " ");
    return {
      text: out,
      usage: { inputTokens: estimateTokens(input.draft), outputTokens: estimateTokens(out) },
    };
  }
}
