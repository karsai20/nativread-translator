import { formatForPrompt } from "../glossary";
import type { GlossaryMap } from "../glossary";
import type { RefineDiagnosis } from "../translator";
import { PLACEHOLDER_OPEN, PLACEHOLDER_CLOSE, BLOCK_MARKER_OPEN, BLOCK_MARKER_CLOSE } from "../markup";

const TOKEN_DESC =
  `text-segment tokens of the form ${PLACEHOLDER_OPEN}N${PLACEHOLDER_CLOSE} (text-node boundaries) ` +
  `and block markers of the form ${BLOCK_MARKER_OPEN}N${BLOCK_MARKER_CLOSE} (paragraph boundaries)`;

const PRESERVE_RULES = [
  `- The text contains ${TOKEN_DESC}. Keep EVERY token and marker EXACTLY as-is, with`,
  `  the same numbers, in the same positions. Never translate, renumber, merge, drop, or`,
  `  add one. Each block marker must appear once, before the paragraph it introduces.`,
];

const CONTEXT_INSTRUCTION =
  `- The user message may open with a "PRECEDING CONTEXT" block (already-translated text: ` +
  `use it ONLY to keep voice, register and formality continuous) and a "PRECEDING SOURCE" ` +
  `block (the source text just before this one: use it ONLY to resolve who or what pronouns ` +
  `and references point to). Never translate, repeat, or output either block.`;

export function literarySystemPrompt(targetLang: string, glossary: GlossaryMap): string {
  const glossaryText = formatForPrompt(glossary);
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
    glossaryText ? `\n${glossaryText}` : ``,
  ]
    .filter((l) => l !== ``)
    .join("\n");
}

export function refineSystemPrompt(targetLang: string, glossary: GlossaryMap): string {
  const glossaryText = formatForPrompt(glossary);
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
    glossaryText ? `\n${glossaryText}` : ``,
  ]
    .filter((l) => l !== ``)
    .join("\n");
}

/**
 * Decide, once per book, how each recurring name/term is rendered. The rules are the ones
 * a Hungarian literary translator applies by reflex — the point is that the whole book
 * applies the SAME reflex, instead of every parallel chunk re-deciding.
 */
export function glossarySystemPrompt(targetLang: string): string {
  return [
    `You are preparing the name/term glossary for a literary translation into ${targetLang}.`,
    `For each source term, give the exact rendering to use throughout the entire book.`,
    `- Keep personal names in their original spelling unless ${targetLang} has an established`,
    `  form for them (e.g. Vienna -> Bécs, the Thames -> a Temze).`,
    `- Render titles and forms of address the ${targetLang} way. In Hungarian these follow`,
    `  the name: "Mr. Holloway" -> "Holloway úr", "Dr. Kane" -> "Kane doktor",`,
    `  "Lord Henry Wotton" -> "Henry Wotton lord". "Lady" is the exception and is kept in`,
    `  front, unchanged: "Lady Brandon" -> "Lady Brandon".`,
    `- Give the base (nominative) form only — the translator adds suffixes as needed.`,
    `- If a term should be used exactly as it stands, map it to itself.`,
    `- OMIT a term entirely if it is not a proper name — an ordinary word that merely got`,
    `  capitalised ("the Church", "the Academy") must not be pinned to a fixed rendering,`,
    `  because the right translation depends on the sentence.`,
    `Reply with ONLY a JSON object of the form {"source term": "rendering", ...}.`,
  ].join("\n");
}

export function estimateSystemPrompt(targetLang: string, glossary: GlossaryMap): string {
  const glossaryText = formatForPrompt(glossary);
  return [
    `You are a strict literary translation quality grader for ${targetLang}.`,
    `You are given a SOURCE passage and a DRAFT ${targetLang} translation.`,
    `Grade the DRAFT and reply with ONLY a JSON object of this exact shape:`,
    `{"score": <1-5 integer>, "omission": <bool>, "accuracy": <bool>, "fluency": <bool>, "weak_blocks": [<int>, ...]}`,
    `score: 5 = publishable, 4 = trivial nits, 3 = worth an edit, 2 = clearly needs revision, 1 = broken.`,
    `omission: true if any source content is missing/untranslated.`,
    `accuracy: true if any meaning is wrong or invented.`,
    `fluency: true if the ${targetLang} reads awkward or unnatural.`,
    `weak_blocks: the numbers of the ${BLOCK_MARKER_OPEN}N${BLOCK_MARKER_CLOSE} blocks that actually need`,
    `rework — empty when the draft is fine, and ONLY the weak ones when some are. Do not list`,
    `every block out of caution: blocks you list get regenerated, blocks you omit are kept.`,
    glossaryText ? `\n${glossaryText}` : ``,
  ]
    .filter((l) => l !== ``)
    .join("\n");
}

/**
 * Render the known defects as an instruction for the editor pass. Deliberately part of the
 * USER message, not the system prompt: it changes per chunk, and the system prompt has to
 * stay byte-identical across calls for provider prefix caching to hit.
 */
export function diagnosisInstruction(d: RefineDiagnosis | undefined): string {
  if (!d) return "";
  const items: string[] = [];
  if (d.omission || d.flags.includes("omission")) {
    items.push(`- Part of the source appears to be missing or untranslated. Restore every sentence.`);
  }
  if (d.accuracy) items.push(`- Some meaning is wrong or invented. Check the draft against the source.`);
  if (d.fluency) items.push(`- The text reads awkward or unnatural. Fix the phrasing, keep the meaning.`);
  if (d.missingGlossary.length > 0) {
    items.push(
      `- These names/terms occur in the source but their agreed rendering is missing from the` +
        ` draft: ${d.missingGlossary.map((t) => `"${t}"`).join(", ")}.`,
    );
  }
  if (d.flags.includes("tokens")) {
    items.push(`- A text-segment token or block marker was lost. Restore the exact set from the source.`);
  }
  if (items.length === 0) return "";
  return `KNOWN PROBLEMS with this draft (fix these first):\n${items.join("\n")}\n\n`;
}

/**
 * Wrap the payload in its context blocks. Ordered most-stable-first (the style anchor is
 * constant for a whole book, the source tail changes per chunk) so a provider's prefix
 * cache keeps hitting for as long as possible.
 */
export function withContext(text: string, prev?: string, sourceContext?: string): string {
  if (!prev && !sourceContext) return text;
  const parts: string[] = [];
  if (prev) parts.push(`PRECEDING CONTEXT (for continuity only, do not translate):\n"""${prev}"""`);
  if (sourceContext) {
    parts.push(`PRECEDING SOURCE (for reference resolution only, do not translate):\n"""${sourceContext}"""`);
  }
  parts.push(`TEXT TO TRANSLATE:\n${text}`);
  return parts.join("\n\n");
}
