// Offline quality/cost eval: run the real chunk pipeline over a fixed sample of a real
// book under several configurations, then report quality signals, cost and latency side
// by side.
//
//   bun run eval path/to/book.epub [--chunks 12] [--only 3.6-flash,3.1-flash-lite]
//
// Costs real money and needs a real key, which is why it is not part of `bun test`.
//
// Two deliberate choices:
//   - Chunks are translated standalone (no continuity anchor). The anchor is a property of
//     a whole-book run, and holding it constant here keeps configs comparable.
//   - The SCORING judge is one fixed model for every config. A judge that changes with the
//     config under test produces numbers that cannot be compared.
//
// The table narrows the field; the per-config Hungarian text is what actually decides.
// An LLM judge does not settle literary quality — read the output.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chunkSpineItem, type Chunk } from "../lib/core/chunker";
import { priceProfileFor, type PriceProfile } from "../lib/core/cost";
import { parseEpub } from "../lib/core/epub";
import { seedFromTexts, type GlossaryMap } from "../lib/core/glossary";
import { OpenAICompatibleTranslator } from "../lib/core/providers/openai-compatible";
import { validateChunk } from "../lib/core/quality/validators";
import { guardChunk } from "../lib/core/quality/guard";
import {
  toPlainText,
  translateBlocks,
  TranslationGuardError,
  type TokenUsage,
} from "../lib/core/translator";
import { CONFIGS, type EvalConfig } from "./configs";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const OUT_DIR = join(import.meta.dir, "out");
/** Fixed scorer, independent of the configs under test. */
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL?.trim() || "gemini-3.5-flash-lite";
const DEFAULT_SAMPLE_SIZE = 12;
/** Skip front/back matter and stubs: a chunk needs real prose to say anything. */
const MIN_CHUNK_WORDS = 120;
/** Same band translator.ts uses in "balanced" mode. */
const LENGTH_BAND = { minLengthRatio: 0.88, maxLengthRatio: 1.45 };

interface ChunkOutcome {
  key: string;
  sourcePlain: string;
  targetPlain: string;
  guardFailed: boolean;
  guardReasons: string[];
  /** Transport/API failure, kept apart from guard rejections so the table stays honest. */
  error?: string;
  localFlags: string[];
  missingGlossary: string[];
  score?: number;
  omission: boolean;
  accuracy: boolean;
  fluency: boolean;
  usage: TokenUsage;
  ms: number;
}

interface ConfigResult {
  config: EvalConfig;
  outcomes: ChunkOutcome[];
  usd: number;
  judgeUsage: TokenUsage;
}

function parseArgs(argv: string[]) {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const epubPath = positional[0];
  if (!epubPath) {
    console.error("usage: bun run eval <book.epub> [--chunks N] [--only name,name]");
    process.exit(1);
  }
  const chunks = Number(flag("chunks")) || DEFAULT_SAMPLE_SIZE;
  const only = flag("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  return { epubPath, sampleSize: chunks, only };
}

function chunkWords(chunk: Chunk): number {
  return chunk.blocks.map((b) => toPlainText(b.innerHtml)).join(" ").match(/\S+/g)?.length ?? 0;
}

/**
 * Deterministic, spread-out sample: substantial chunks only, evenly spaced across the
 * book so dialogue-heavy and narration-heavy passages both show up. Same book in, same
 * chunks out — runs stay comparable over time.
 */
function sampleChunks(all: Chunk[], size: number): Chunk[] {
  const eligible = all.filter((c) => chunkWords(c) >= MIN_CHUNK_WORDS);
  if (eligible.length <= size) return eligible;
  const stride = eligible.length / size;
  return Array.from({ length: size }, (_, i) => eligible[Math.floor(i * stride)]!);
}

function makeTranslator(config: EvalConfig, apiKey: string): OpenAICompatibleTranslator {
  return new OpenAICompatibleTranslator({
    name: config.name,
    apiKey,
    model: config.model,
    baseUrl: GEMINI_BASE_URL,
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(config.thinkingBody ? { thinkingBody: config.thinkingBody } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.reasonerModel ? { reasonerModel: config.reasonerModel } : {}),
  });
}

function addUsage(a: TokenUsage, b?: TokenUsage): TokenUsage {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
  };
}

function usdOf(usage: TokenUsage, profile: PriceProfile): number {
  const fresh = Math.max(0, usage.inputTokens - (usage.cachedInputTokens ?? 0));
  return (
    (fresh / 1_000_000) * profile.inputPerMTok +
    ((usage.cachedInputTokens ?? 0) / 1_000_000) * profile.cachedInputPerMTok +
    (usage.outputTokens / 1_000_000) * profile.outputPerMTok
  );
}

async function runConfig(
  config: EvalConfig,
  chunks: Chunk[],
  seeded: GlossaryMap,
  judge: OpenAICompatibleTranslator,
  apiKey: string,
): Promise<ConfigResult> {
  const provider = makeTranslator(config, apiKey);

  let glossary = seeded;
  if (config.prefillGlossary) {
    const filled = await provider.fillGlossary({
      terms: Object.keys(seeded),
      targetLang: "Hungarian",
    });
    if (Object.keys(filled.glossary).length > 0) glossary = filled.glossary;
    const decided = Object.values(filled.glossary).filter(Boolean).length;
    console.log(`  ${config.name}: glossary prefilled, ${decided}/${Object.keys(seeded).length} terms decided`);
  }
  const outcomes: ChunkOutcome[] = [];
  let judgeUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

  for (const [i, chunk] of chunks.entries()) {
    process.stdout.write(`\r  ${config.name}: chunk ${i + 1}/${chunks.length}   `);
    const sourcePlain = chunk.blocks.map((b) => toPlainText(b.innerHtml)).join("\n");
    const started = Date.now();

    let targetPlain = "";
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    let guardFailed = false;
    let guardReasons: string[] = [];
    let error: string | undefined;

    try {
      const out = await translateBlocks(provider, chunk.blocks, {
        glossary,
        refine: config.refine,
        selectiveRefine: config.selectiveRefine,
        precision: "balanced",
      });
      targetPlain = out.plainText;
      usage = out.usage;
      // translateBlocks only throws once its own retry also failed; re-checking here
      // records residual damage that survived into an accepted chunk.
      const report = guardChunk(
        out.blocks.map((b) => ({
          index: b.index,
          sourcePlain: toPlainText(chunk.blocks.find((s) => s.index === b.index)?.innerHtml ?? ""),
          targetHtml: b.html,
          targetPlain: toPlainText(b.html),
        })),
      );
      guardReasons = report.reasons.map((r) => r.reason);
      guardFailed = !report.ok;
    } catch (err) {
      if (err instanceof TranslationGuardError) {
        guardFailed = true;
        guardReasons = err.reasons.map((r) => r.reason);
      } else {
        // A 401 or a timeout is not a quality signal — counting it as one would poison
        // the comparison the eval exists to produce.
        error = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 120) : "unknown error";
      }
    }

    const ms = Date.now() - started;
    const local = validateChunk(
      {
        sourcePlain,
        targetPlain,
        // Tokenized forms are only used for the placeholder-count check, which
        // translateBlocks already enforces on restore; plain text keeps that check quiet.
        sourceTokenized: sourcePlain,
        targetTokenized: targetPlain,
        glossary,
      },
      LENGTH_BAND,
    );

    let score: number | undefined;
    let omission = false;
    let accuracy = false;
    let fluency = false;
    if (targetPlain.trim()) {
      try {
        const verdict = await judge.estimateChunk({
          source: sourcePlain,
          draft: targetPlain,
          targetLang: "Hungarian",
          glossary,
        });
        score = verdict.score;
        omission = Boolean(verdict.omission);
        accuracy = Boolean(verdict.accuracy);
        fluency = Boolean(verdict.fluency);
        judgeUsage = addUsage(judgeUsage, verdict.usage);
      } catch (err) {
        console.error(`\n  judge failed on ${chunk.key}: ${err instanceof Error ? err.message : err}`);
      }
    }

    outcomes.push({
      key: chunk.key,
      sourcePlain,
      targetPlain,
      guardFailed,
      guardReasons,
      localFlags: local.flags,
      missingGlossary: local.missingGlossary,
      score,
      omission,
      accuracy,
      fluency,
      usage,
      ms,
      ...(error ? { error } : {}),
    });
  }

  process.stdout.write("\r");
  const profile = priceProfileFor(config.model);
  const usd = outcomes.reduce((sum, o) => sum + usdOf(o.usage, profile), 0);
  return { config, outcomes, usd, judgeUsage };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Extrapolate a sample to a whole book, so the table answers "what does this cost me". */
function perBookUsd(result: ConfigResult, sampled: number, totalChunks: number): number {
  return sampled === 0 ? 0 : (result.usd / sampled) * totalChunks;
}

function summaryTable(results: ConfigResult[], sampled: number, totalChunks: number): string {
  const header =
    "| config | átlag pont | guard | hiba | omission | glossary hiány | $/minta | $/könyv (becslés) | átlag mp/chunk |\n" +
    "|---|---|---|---|---|---|---|---|---|";
  const rows = results.map((r) => {
    const scores = r.outcomes.map((o) => o.score).filter((s): s is number => s !== undefined);
    const guard = r.outcomes.filter((o) => o.guardFailed).length;
    const errors = r.outcomes.filter((o) => o.error).length;
    const omission = r.outcomes.filter((o) => o.omission || o.localFlags.includes("omission")).length;
    const missing = r.outcomes.reduce((n, o) => n + o.missingGlossary.length, 0);
    return [
      r.config.name,
      scores.length ? mean(scores).toFixed(2) : "—",
      `${guard}/${r.outcomes.length}`,
      errors ? `${errors}/${r.outcomes.length}` : "—",
      `${omission}/${r.outcomes.length}`,
      String(missing),
      `$${r.usd.toFixed(3)}`,
      `$${perBookUsd(r, sampled, totalChunks).toFixed(2)}`,
      (mean(r.outcomes.map((o) => o.ms)) / 1000).toFixed(1),
    ].join(" | ");
  });
  return [header, ...rows.map((r) => `| ${r} |`)].join("\n");
}

function configReport(result: ConfigResult): string {
  const lines = [`# ${result.config.name}`, "", "```json", JSON.stringify(result.config, null, 2), "```", ""];
  for (const o of result.outcomes) {
    const marks = [
      o.score !== undefined ? `pont: ${o.score}` : "pont: —",
      o.error ? `HIBA: ${o.error}` : "",
      o.guardFailed ? `GUARD: ${o.guardReasons.join(",")}` : "",
      o.localFlags.length ? `flags: ${o.localFlags.join(",")}` : "",
      o.missingGlossary.length ? `hiányzó nevek: ${o.missingGlossary.join(", ")}` : "",
    ].filter(Boolean);
    lines.push(`## ${o.key}`, "", `_${marks.join(" · ")}_`, "", "**EN**", "", o.sourcePlain, "", "**HU**", "", o.targetPlain || "_(üres)_", "");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { epubPath, sampleSize, only } = parseArgs(process.argv.slice(2));
  const apiKey = (process.env.PROVIDER_API_KEY ?? process.env.GEMINI_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error("PROVIDER_API_KEY (or GEMINI_API_KEY) is required — the eval calls the real API.");
    process.exit(1);
  }

  const epub = parseEpub(new Uint8Array(readFileSync(epubPath)));
  const allChunks: Chunk[] = [];
  for (const item of epub.spine) {
    allChunks.push(...chunkSpineItem(item.href, item.content).chunks);
  }
  const glossary: GlossaryMap = seedFromTexts(epub.spine.map((item) => item.content));

  const chunks = sampleChunks(allChunks, sampleSize);
  const configs = only ? CONFIGS.filter((c) => only.includes(c.name)) : CONFIGS;
  if (configs.length === 0) {
    console.error(`No config matched --only. Known: ${CONFIGS.map((c) => c.name).join(", ")}`);
    process.exit(1);
  }

  console.log(`Book: ${epub.title ?? epubPath}`);
  console.log(`Chunks: ${chunks.length} sampled of ${allChunks.length} · glossary terms: ${Object.keys(glossary).length}`);
  console.log(`Configs: ${configs.map((c) => c.name).join(", ")} · judge: ${JUDGE_MODEL}\n`);

  const judge = new OpenAICompatibleTranslator({
    name: "judge",
    apiKey,
    model: JUDGE_MODEL,
    baseUrl: GEMINI_BASE_URL,
    // Without this a thinking model spends the verdict's token budget on thoughts and
    // returns truncated JSON — every chunk then scores "no verdict" and the column is void.
    ...(/^gemini-3/.test(JUDGE_MODEL)
      ? { thinkingBody: { extra_body: { google: { thinking_config: { thinking_level: "minimal" } } } } }
      : { reasoningEffort: "none" }),
  });

  mkdirSync(OUT_DIR, { recursive: true });
  const results: ConfigResult[] = [];
  for (const config of configs) {
    const result = await runConfig(config, chunks, glossary, judge, apiKey);
    results.push(result);
    writeFileSync(join(OUT_DIR, `${config.name}.md`), configReport(result));
    console.log(`✓ ${config.name}: $${result.usd.toFixed(3)} on ${chunks.length} chunks`);
  }

  const judgeUsd = results.reduce(
    (sum, r) => sum + usdOf(r.judgeUsage, priceProfileFor(JUDGE_MODEL)),
    0,
  );
  const table = summaryTable(results, chunks.length, allChunks.length);
  const summary = [
    `# Eval: ${epub.title ?? epubPath}`,
    "",
    `${chunks.length} chunk mintavéve ${allChunks.length}-ből · bíráló: ${JUDGE_MODEL} · bírálat költsége: $${judgeUsd.toFixed(3)}`,
    "",
    table,
    "",
    "A $/könyv oszlop a minta lineáris kivetítése az összes chunkra, azonos refine-aránnyal.",
    "A pontszám az irányt mutatja, nem dönt: a magyar szöveget el kell olvasni (`eval/out/<config>.md`).",
    "",
  ].join("\n");

  writeFileSync(join(OUT_DIR, "summary.md"), summary);
  console.log(`\n${table}\n`);
  console.log(`Bíráló költsége: $${judgeUsd.toFixed(3)} · részletek: eval/out/`);
}

await main();
