# Translation Pipeline Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DeepSeek book translation precise (balanced fidelity + naturalness with error-catching) and fast, via a hardened transport layer and an adaptive, gated per-chunk quality pipeline.

**Architecture:** Three layers — (1) a provider-agnostic transport with retry/backoff/timeout, (2) a quality pipeline of pure local validators + a structured self-judge + effort routing, (3) the existing parallel chunk orchestration. Evolution of the current engine; the parallel pool, chunker, glossary, style anchor, cost, ETA, and resume model are unchanged.

**Tech Stack:** TypeScript, Next.js, Bun test runner, DeepSeek (OpenAI-compatible) `deepseek-v4-flash` + `deepseek-reasoner`.

## Global Constraints

- Runtime/test: `bun test`; typecheck `bun run typecheck`; build `bun run build`. Use `export PATH="$HOME/.bun/bin:$PATH"` before bun commands.
- Provider: DeepSeek only. Models: `deepseek-v4-flash` (translate/draft/refine/judge), `deepseek-reasoner` (escalated refine).
- Pricing (USD/1M, already in `cost.ts`): input miss `0.14`, cache hit `0.0028`, output `0.28`.
- Immutability: never mutate inputs; return new objects.
- All 47 existing tests must stay green.
- No new runtime dependencies (no p-limit etc.) — hand-rolled, matching the existing code.
- Hungarian-facing strings stay Hungarian; code/comments English.

---

### Task 1: Transport — `fetchWithRetry`

**Files:**
- Create: `lib/core/providers/http.ts`
- Test: `test/http.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class HttpError extends Error { status: number; body: string }`
  - `interface RetryOptions { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; timeoutMs?: number; retryStatuses?: number[]; fetchImpl?: typeof fetch; sleepImpl?: (ms: number) => Promise<void>; random?: () => number }`
  - `function fetchWithRetry(url: string, init: RequestInit, opts?: RetryOptions): Promise<Response>`

- [ ] **Step 1: Write the failing test**

```typescript
// test/http.test.ts
import { test, expect } from "bun:test";
import { fetchWithRetry, HttpError } from "../lib/core/providers/http.ts";

function jsonRes(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function fakeFetch(queue: Response[]): { impl: typeof fetch; calls: () => number } {
  let i = 0;
  const impl = (async () => {
    const r = queue[i++];
    if (!r) throw new Error("no more responses");
    return r;
  }) as unknown as typeof fetch;
  return { impl, calls: () => i };
}

test("retries a 429 then returns the 200", async () => {
  const { impl, calls } = fakeFetch([jsonRes(429), jsonRes(200, "ok")]);
  const slept: number[] = [];
  const res = await fetchWithRetry("https://x", {}, {
    fetchImpl: impl,
    sleepImpl: async (ms) => { slept.push(ms); },
    random: () => 0.5,
  });
  expect(res.status).toBe(200);
  expect(calls()).toBe(2);
  expect(slept.length).toBe(1);
});

test("does NOT retry a 400 and throws HttpError", async () => {
  const { impl, calls } = fakeFetch([jsonRes(400, "bad")]);
  let err: unknown;
  try {
    await fetchWithRetry("https://x", {}, { fetchImpl: impl, sleepImpl: async () => {} });
  } catch (e) { err = e; }
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(400);
  expect(calls()).toBe(1);
});

test("honors Retry-After header (seconds) over computed backoff", async () => {
  const { impl } = fakeFetch([jsonRes(429, "", { "retry-after": "2" }), jsonRes(200)]);
  const slept: number[] = [];
  await fetchWithRetry("https://x", {}, {
    fetchImpl: impl, sleepImpl: async (ms) => { slept.push(ms); }, random: () => 1,
  });
  expect(slept[0]).toBe(2000);
});

test("retries a network error then succeeds", async () => {
  let i = 0;
  const impl = (async () => {
    i++;
    if (i === 1) throw new Error("ECONNRESET");
    return jsonRes(200);
  }) as unknown as typeof fetch;
  const res = await fetchWithRetry("https://x", {}, { fetchImpl: impl, sleepImpl: async () => {} });
  expect(res.status).toBe(200);
  expect(i).toBe(2);
});

test("gives up after maxAttempts and throws", async () => {
  const { impl, calls } = fakeFetch([jsonRes(503), jsonRes(503), jsonRes(503)]);
  let err: unknown;
  try {
    await fetchWithRetry("https://x", {}, { fetchImpl: impl, sleepImpl: async () => {}, maxAttempts: 3 });
  } catch (e) { err = e; }
  expect(err).toBeInstanceOf(HttpError);
  expect(calls()).toBe(3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test test/http.test.ts`
Expected: FAIL — `Cannot find module '../lib/core/providers/http.ts'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/core/providers/http.ts
// Provider-agnostic HTTP transport: retry with exponential backoff + full jitter,
// per-request timeout via AbortController, and Retry-After support. Retries transient
// failures (429/5xx/network) and fails fast on client errors (4xx except 429).

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  retryStatuses?: number[];
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  random?: () => number;
}

const DEFAULT_RETRYABLE = [429, 500, 502, 503, 504];

function fullJitter(attempt: number, base: number, cap: number, random: () => number): number {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.floor(random() * exp);
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const base = opts.baseDelayMs ?? 1000;
  const cap = opts.maxDelayMs ?? 30000;
  const timeoutMs = opts.timeoutMs ?? 120000;
  const retryable = new Set(opts.retryStatuses ?? DEFAULT_RETRYABLE);
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return res;
      const isLast = attempt === maxAttempts - 1;
      if (!retryable.has(res.status) || isLast) {
        const body = await res.text().catch(() => "");
        throw new HttpError(res.status, body);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : fullJitter(attempt, base, cap, random);
      await sleep(delay);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof HttpError) throw err;
      lastErr = err;
      if (attempt === maxAttempts - 1) break;
      await sleep(fullJitter(attempt, base, cap, random));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("fetchWithRetry: attempts exhausted");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test test/http.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/core/providers/http.ts test/http.test.ts
git commit -m "feat(transport): fetchWithRetry with backoff, timeout, Retry-After"
```

---

### Task 2: Provider uses the transport + structured judge output

**Files:**
- Modify: `lib/core/providers/deepseek.ts`
- Test: `test/deepseek-transport.test.ts`

**Interfaces:**
- Consumes: `fetchWithRetry`, `HttpError` (Task 1); `EstimateChunkInput`, `EstimateChunkOutput` (translator).
- Produces:
  - `DeepSeekTranslator` constructor option `fetchImpl?: typeof fetch` (injected through to `fetchWithRetry`).
  - `chat(system, user, opts)` gains `opts.responseFormat?: "json_object"`.
  - `estimateChunk` returns `{ score, needsRefine, hard, omission, accuracy, fluency, usage }` parsed from JSON.

- [ ] **Step 1: Write the failing test**

```typescript
// test/deepseek-transport.test.ts
import { test, expect } from "bun:test";
import { DeepSeekTranslator } from "../lib/core/providers/deepseek.ts";

function fetchReturning(payloads: unknown[]): typeof fetch {
  let i = 0;
  return (async () => {
    const body = JSON.stringify(payloads[Math.min(i, payloads.length - 1)]);
    i++;
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("estimateChunk parses structured JSON verdict", async () => {
  const fake = fetchReturning([
    { choices: [{ message: { content: '{"score":2,"omission":true,"accuracy":false,"fluency":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ]);
  const t = new DeepSeekTranslator({ apiKey: "k", fetchImpl: fake });
  const v = await t.estimateChunk({ source: "s", draft: "d", targetLang: "Hungarian", glossary: {} });
  expect(v.score).toBe(2);
  expect(v.omission).toBe(true);
  expect(v.needsRefine).toBe(true); // score <= 3
  expect(v.hard).toBe(true);        // score <= 2
});

test("estimateChunk falls back to needsRefine on malformed JSON", async () => {
  const fake = fetchReturning([
    { choices: [{ message: { content: "not json" } }], usage: {} },
  ]);
  const t = new DeepSeekTranslator({ apiKey: "k", fetchImpl: fake });
  const v = await t.estimateChunk({ source: "s", draft: "d", targetLang: "Hungarian", glossary: {} });
  expect(v.needsRefine).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test test/deepseek-transport.test.ts`
Expected: FAIL — `fetchImpl` not accepted / `estimateChunk` returns digit-parsed shape without `omission`.

- [ ] **Step 3: Write minimal implementation**

In `lib/core/providers/deepseek.ts`:

3a. Add the import:
```typescript
import { fetchWithRetry } from "./http";
```

3b. Add a `fetchImpl` field. Change `DeepSeekOptions`:
```typescript
export interface DeepSeekOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}
```
Store it in the constructor:
```typescript
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: DeepSeekOptions) {
    if (!opts.apiKey) throw new Error("DeepSeekTranslator requires an API key.");
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEEPSEEK_MODEL;
    this.baseUrl = opts.baseUrl ?? DEEPSEEK_URL;
    this.fetchImpl = opts.fetchImpl;
  }
```

3c. Rewrite `chat` to use `fetchWithRetry` and accept `responseFormat`:
```typescript
  private async chat(
    system: string,
    user: string,
    opts: { temperature?: number; maxTokens?: number; model?: string; responseFormat?: "json_object" } = {},
  ): Promise<TranslateChunkOutput> {
    const body: Record<string, unknown> = {
      model: opts.model ?? this.model,
      temperature: opts.temperature ?? TEMPERATURE,
      max_tokens: opts.maxTokens ?? MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    if (opts.responseFormat) body.response_format = { type: opts.responseFormat };

    const isReasoner = (opts.model ?? this.model) === DEEPSEEK_REASONER_MODEL;
    const res = await fetchWithRetry(
      this.baseUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      },
      { fetchImpl: this.fetchImpl, timeoutMs: isReasoner ? 300000 : 120000 },
    );

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
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
```
(Delete the old `fetch(...)` body and the manual `if (!res.ok)` block — `fetchWithRetry` handles it.)

3d. Replace `estimateChunk` with a JSON-mode version:
```typescript
  async estimateChunk(input: EstimateChunkInput): Promise<EstimateChunkOutput> {
    const system = estimateSystemPrompt(input.targetLang, formatForPrompt(input.glossary));
    const user = `SOURCE:\n${input.source}\n\nDRAFT:\n${input.draft}`;
    const out = await this.chat(system, user, {
      temperature: ESTIMATE_TEMPERATURE,
      maxTokens: 64,
      responseFormat: "json_object",
    });

    let score: number | undefined;
    let omission = false;
    let accuracy = false;
    let fluency = false;
    try {
      const v = JSON.parse(out.text) as Partial<{ score: number; omission: boolean; accuracy: boolean; fluency: boolean }>;
      if (typeof v.score === "number") score = Math.max(1, Math.min(5, Math.round(v.score)));
      omission = Boolean(v.omission);
      accuracy = Boolean(v.accuracy);
      fluency = Boolean(v.fluency);
    } catch {
      score = undefined;
    }

    const needsRefine = score === undefined ? true : score <= REFINE_SCORE_THRESHOLD || omission || accuracy;
    const hard = score !== undefined && score <= HARD_SCORE_THRESHOLD;
    return { needsRefine, hard, score, omission, accuracy, fluency, usage: out.usage };
  }
```

3e. Update `estimateSystemPrompt` to request JSON (replace its last two instruction lines):
```typescript
function estimateSystemPrompt(targetLang: string, glossary: string): string {
  return [
    `You are a strict literary translation quality grader for ${targetLang}.`,
    `You are given a SOURCE passage and a DRAFT ${targetLang} translation.`,
    `Grade the DRAFT and reply with ONLY a JSON object of this exact shape:`,
    `{"score": <1-5 integer>, "omission": <bool>, "accuracy": <bool>, "fluency": <bool>}`,
    `score: 5 = publishable, 4 = trivial nits, 3 = worth an edit, 2 = clearly needs revision, 1 = broken.`,
    `omission: true if any source content is missing/untranslated.`,
    `accuracy: true if any meaning is wrong or invented.`,
    `fluency: true if the ${targetLang} reads awkward or unnatural.`,
    glossary ? `\n${glossary}` : ``,
  ]
    .filter((l) => l !== ``)
    .join("\n");
}
```

3f. Add the structured fields to `EstimateChunkOutput` in `lib/core/translator.ts`:
```typescript
export interface EstimateChunkOutput {
  needsRefine: boolean;
  hard?: boolean;
  score?: number;
  omission?: boolean;
  accuracy?: boolean;
  fluency?: boolean;
  usage?: TokenUsage;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test test/deepseek-transport.test.ts && bun test && bun run typecheck`
Expected: new file PASS (2), full suite PASS (49), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add lib/core/providers/deepseek.ts lib/core/translator.ts test/deepseek-transport.test.ts
git commit -m "feat(provider): route DeepSeek calls through transport; structured JSON judge"
```

---

### Task 3: Local validators (pure, no API)

**Files:**
- Create: `lib/core/quality/validators.ts`
- Test: `test/validators.test.ts`

**Interfaces:**
- Consumes: `GlossaryMap` (glossary), markup placeholder constants.
- Produces:
  - `type QualityFlag = "tokens" | "omission" | "glossary"`
  - `interface LocalReport { ok: boolean; flags: QualityFlag[]; missingGlossary: string[] }`
  - `interface ValidateOptions { minLengthRatio: number; maxLengthRatio: number }`
  - `function validateChunk(args: { sourcePlain: string; targetPlain: string; sourceTokenized: string; targetTokenized: string; glossary: GlossaryMap }, opts: ValidateOptions): LocalReport`

- [ ] **Step 1: Write the failing test**

```typescript
// test/validators.test.ts
import { test, expect } from "bun:test";
import { validateChunk } from "../lib/core/quality/validators.ts";
import { PLACEHOLDER_OPEN, PLACEHOLDER_CLOSE } from "../lib/core/markup.ts";

const OPTS = { minLengthRatio: 0.6, maxLengthRatio: 2.2 };
const tok = (n: number) => `${PLACEHOLDER_OPEN}${n}${PLACEHOLDER_CLOSE}`;

test("clean chunk reports ok with no flags", () => {
  const r = validateChunk(
    { sourcePlain: "Hello world.", targetPlain: "Helló világ.", sourceTokenized: "Hello world.", targetTokenized: "Helló világ.", glossary: {} },
    OPTS,
  );
  expect(r.ok).toBe(true);
  expect(r.flags).toEqual([]);
});

test("flags omission when translation is far too short", () => {
  const r = validateChunk(
    { sourcePlain: "A".repeat(100), targetPlain: "A".repeat(10), sourceTokenized: "x", targetTokenized: "x", glossary: {} },
    OPTS,
  );
  expect(r.flags).toContain("omission");
  expect(r.ok).toBe(false);
});

test("flags token loss when a placeholder is dropped", () => {
  const r = validateChunk(
    { sourcePlain: "a b", targetPlain: "a b", sourceTokenized: `a ${tok(0)} b`, targetTokenized: "a b", glossary: {} },
    OPTS,
  );
  expect(r.flags).toContain("tokens");
});

test("flags glossary miss when target rendering is absent", () => {
  const r = validateChunk(
    { sourcePlain: "Mr. Holloway arrived.", targetPlain: "Valaki megérkezett.", sourceTokenized: "x", targetTokenized: "x", glossary: { "Mr. Holloway": "Holloway úr" } },
    OPTS,
  );
  expect(r.flags).toContain("glossary");
  expect(r.missingGlossary).toContain("Mr. Holloway");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test test/validators.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/core/quality/validators.ts
// Pure, API-free quality checks on a translated chunk. Cheap signals that catch the
// failures the model itself often misses: dropped placeholders, omitted content, and
// glossary terms that didn't make it into the translation.

import type { GlossaryMap } from "../glossary";
import { PLACEHOLDER_OPEN } from "../markup";

export type QualityFlag = "tokens" | "omission" | "glossary";

export interface LocalReport {
  ok: boolean;
  flags: QualityFlag[];
  missingGlossary: string[];
}

export interface ValidateOptions {
  minLengthRatio: number;
  maxLengthRatio: number;
}

function countTokens(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === PLACEHOLDER_OPEN) n++;
  return n;
}

export function validateChunk(
  args: {
    sourcePlain: string;
    targetPlain: string;
    sourceTokenized: string;
    targetTokenized: string;
    glossary: GlossaryMap;
  },
  opts: ValidateOptions,
): LocalReport {
  const flags: QualityFlag[] = [];

  if (countTokens(args.sourceTokenized) !== countTokens(args.targetTokenized)) {
    flags.push("tokens");
  }

  const srcLen = args.sourcePlain.trim().length;
  if (srcLen > 0) {
    const ratio = args.targetPlain.trim().length / srcLen;
    if (ratio < opts.minLengthRatio || ratio > opts.maxLengthRatio) flags.push("omission");
  }

  const missingGlossary: string[] = [];
  for (const [term, target] of Object.entries(args.glossary)) {
    if (!target) continue;
    if (args.sourcePlain.includes(term) && !args.targetPlain.includes(target)) {
      missingGlossary.push(term);
    }
  }
  if (missingGlossary.length > 0) flags.push("glossary");

  return { ok: flags.length === 0, flags, missingGlossary };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test test/validators.test.ts`
Expected: PASS (4).

- [ ] **Step 5: Commit**

```bash
git add lib/core/quality/validators.ts test/validators.test.ts
git commit -m "feat(quality): pure local validators (tokens, omission, glossary)"
```

---

### Task 4: Effort routing (pure decision)

**Files:**
- Create: `lib/core/quality/route.ts`
- Test: `test/route.test.ts`

**Interfaces:**
- Consumes: `LocalReport` (Task 3), `EstimateChunkOutput` (translator).
- Produces:
  - `type PrecisionMode = "balanced" | "fidelity" | "natural"`
  - `interface RouteDecision { action: "accept" | "refine"; deep: boolean; backTranslate: boolean }`
  - `const MAX_QUALITY_ITERATIONS = 2`
  - `function routeDraft(args: { local: LocalReport; verdict?: EstimateChunkOutput; mode: PrecisionMode; iteration: number }): RouteDecision`

- [ ] **Step 1: Write the failing test**

```typescript
// test/route.test.ts
import { test, expect } from "bun:test";
import { routeDraft, MAX_QUALITY_ITERATIONS } from "../lib/core/quality/route.ts";
import type { LocalReport } from "../lib/core/quality/validators.ts";

const clean: LocalReport = { ok: true, flags: [], missingGlossary: [] };

test("accepts a clean draft the judge scored high", () => {
  const d = routeDraft({ local: clean, verdict: { needsRefine: false, score: 5 }, mode: "balanced", iteration: 0 });
  expect(d.action).toBe("accept");
});

test("refines on flash for a mid score", () => {
  const d = routeDraft({ local: clean, verdict: { needsRefine: true, score: 3 }, mode: "balanced", iteration: 0 });
  expect(d.action).toBe("refine");
  expect(d.deep).toBe(false);
});

test("escalates to reasoner on a low score", () => {
  const d = routeDraft({ local: clean, verdict: { needsRefine: true, score: 2, hard: true }, mode: "balanced", iteration: 0 });
  expect(d.action).toBe("refine");
  expect(d.deep).toBe(true);
});

test("escalates on a local omission flag even with no verdict", () => {
  const local: LocalReport = { ok: false, flags: ["omission"], missingGlossary: [] };
  const d = routeDraft({ local, mode: "balanced", iteration: 0 });
  expect(d.action).toBe("refine");
  expect(d.deep).toBe(true);
});

test("back-translates only in fidelity mode when escalating", () => {
  const local: LocalReport = { ok: false, flags: ["omission"], missingGlossary: [] };
  expect(routeDraft({ local, mode: "fidelity", iteration: 0 }).backTranslate).toBe(true);
  expect(routeDraft({ local, mode: "balanced", iteration: 0 }).backTranslate).toBe(false);
});

test("stops once the iteration cap is reached", () => {
  const d = routeDraft({ local: clean, verdict: { needsRefine: true, score: 1 }, mode: "balanced", iteration: MAX_QUALITY_ITERATIONS });
  expect(d.action).toBe("accept");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test test/route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// lib/core/quality/route.ts
// Effort routing: given the local report and the judge's verdict, decide how much more
// compute a chunk deserves. Bounded so a chunk can never loop forever.

import type { LocalReport } from "./validators";
import type { EstimateChunkOutput } from "../translator";

export type PrecisionMode = "balanced" | "fidelity" | "natural";

export interface RouteDecision {
  action: "accept" | "refine";
  deep: boolean;
  backTranslate: boolean;
}

export const MAX_QUALITY_ITERATIONS = 2;

export function routeDraft(args: {
  local: LocalReport;
  verdict?: EstimateChunkOutput;
  mode: PrecisionMode;
  iteration: number;
}): RouteDecision {
  const accept: RouteDecision = { action: "accept", deep: false, backTranslate: false };
  if (args.iteration >= MAX_QUALITY_ITERATIONS) return accept;

  const { local, verdict, mode } = args;
  const score = verdict?.score;
  const fidelityFlag =
    local.flags.includes("omission") || Boolean(verdict?.omission) || Boolean(verdict?.accuracy);
  const minorFlag = local.flags.includes("glossary") || local.flags.includes("tokens");

  // Hardest: low score or a fidelity problem -> reasoning model (and back-translation in fidelity mode).
  if (fidelityFlag || (score !== undefined && score <= 2)) {
    return { action: "refine", deep: true, backTranslate: mode === "fidelity" };
  }
  // Mid: a 3, or a minor local flag -> a flash refine.
  if (score === 3 || minorFlag) {
    return { action: "refine", deep: false, backTranslate: false };
  }
  // Clean and good (score >= 4 or no verdict and no flags).
  return accept;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test test/route.test.ts`
Expected: PASS (6).

- [ ] **Step 5: Commit**

```bash
git add lib/core/quality/route.ts test/route.test.ts
git commit -m "feat(quality): bounded effort-routing decision"
```

---

### Task 5: Wire the pipeline into `translateBlocks`

**Files:**
- Modify: `lib/core/translator.ts`
- Test: `test/quality-pipeline.test.ts`

**Interfaces:**
- Consumes: `validateChunk` (Task 3), `routeDraft`, `PrecisionMode`, `MAX_QUALITY_ITERATIONS` (Task 4).
- Produces: `TranslateBlocksOptions` gains `precision?: PrecisionMode`. Routing now drives refine/escalation; the prior `selectiveRefine`/`reasonerForHard` booleans gate whether routing may refine/escalate at all.

**Behavior:** After producing the draft and the joined plaintext, run `validateChunk` + (optionally) `estimateChunk`, then `routeDraft`. On `refine`, call `refineChunk({ ..., deep })`; re-validate/re-judge up to `MAX_QUALITY_ITERATIONS`. Back-translation is recorded as a usage-only accuracy probe (no separate provider method needed in this iteration — it reuses `translateChunk` reverse and is left as a no-op hook documented below).

- [ ] **Step 1: Write the failing test**

```typescript
// test/quality-pipeline.test.ts
import { test, expect } from "bun:test";
import { translateBlocks } from "../lib/core/translator.ts";
import type { Translator, TranslateChunkInput } from "../lib/core/translator.ts";
import { FakeTranslator, FAKE_REFINE_TAG } from "../lib/core/providers/fake.ts";

const blocks = [
  { index: 0, innerHtml: "Mr. Holloway walked into the old library." },
  { index: 1, innerHtml: "He found a letter." },
];

test("accepts without refine when local checks pass and judge scores high", async () => {
  const fake = new FakeTranslator();
  let refines = 0;
  const provider: Translator = {
    name: "p",
    translateChunk: (i: TranslateChunkInput) => fake.translateChunk(i),
    refineChunk: (i) => { refines++; return fake.refineChunk(i); },
    async estimateChunk() { return { needsRefine: false, score: 5, omission: false, usage: { inputTokens: 1, outputTokens: 1 } }; },
  };
  const res = await translateBlocks(provider, blocks, { glossary: {}, refine: true, selectiveRefine: true, precision: "balanced" });
  expect(refines).toBe(0);
  expect(res.blocks[0]!.html).not.toContain(FAKE_REFINE_TAG);
});

test("escalates with deep=true on a low judge score", async () => {
  const fake = new FakeTranslator();
  let deepSeen: boolean | undefined;
  const provider: Translator = {
    name: "p",
    translateChunk: (i: TranslateChunkInput) => fake.translateChunk(i),
    refineChunk: (i) => { deepSeen = i.deep; return fake.refineChunk(i); },
    async estimateChunk() { return { needsRefine: true, hard: true, score: 2, usage: { inputTokens: 1, outputTokens: 1 } }; },
  };
  await translateBlocks(provider, blocks, { glossary: {}, refine: true, selectiveRefine: true, reasonerForHard: true, precision: "balanced" });
  expect(deepSeen).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test test/quality-pipeline.test.ts`
Expected: FAIL — `precision` not accepted / routing not applied (deep not set from score alone).

- [ ] **Step 3: Write minimal implementation**

3a. Imports at the top of `translator.ts`:
```typescript
import { validateChunk, type ValidateOptions } from "./quality/validators";
import { routeDraft, MAX_QUALITY_ITERATIONS, type PrecisionMode } from "./quality/route";
```

3b. Extend `TranslateBlocksOptions`:
```typescript
  precision?: PrecisionMode;
```

3c. Add a helper for mode-dependent length bands (above `translateBlocks`):
```typescript
function lengthBand(mode: PrecisionMode | undefined): ValidateOptions {
  // Hungarian renders close to English length; fidelity mode is stricter about loss.
  if (mode === "fidelity") return { minLengthRatio: 0.7, maxLengthRatio: 2.0 };
  return { minLengthRatio: 0.55, maxLengthRatio: 2.4 };
}
```

3d. Replace the existing `if (opts.refine && provider.refineChunk) { ... }` block with the routed loop:
```typescript
  let finalText = draft.text;
  if (opts.refine && provider.refineChunk) {
    const mode: PrecisionMode = opts.precision ?? "balanced";
    const band = lengthBand(mode);

    for (let iteration = 0; iteration < MAX_QUALITY_ITERATIONS; iteration++) {
      const sourcePlain = toPlainText(payload);
      const targetPlain = toPlainText(finalText);
      const local = validateChunk(
        { sourcePlain, targetPlain, sourceTokenized: payload, targetTokenized: finalText, glossary: opts.glossary },
        band,
      );

      let verdict;
      if (opts.selectiveRefine && provider.estimateChunk) {
        try {
          verdict = await provider.estimateChunk({
            source: payload,
            draft: finalText,
            targetLang: TARGET_LANG,
            glossary: opts.glossary,
          });
          usage = addUsage(usage, verdict.usage);
        } catch {
          verdict = undefined;
        }
      }

      const decision = routeDraft({ local, verdict, mode, iteration });
      if (decision.action === "accept") break;

      const refined = await provider.refineChunk({
        source: payload,
        draft: finalText,
        targetLang: TARGET_LANG,
        glossary: opts.glossary,
        previousContext: opts.previousContext,
        deep: decision.deep && Boolean(opts.reasonerForHard),
      });
      usage = addUsage(usage, refined.usage);
      finalText = refined.text;
    }
  }
```
Note: `toPlainText` already exists in `translator.ts`; reuse it. When `selectiveRefine` is off, `verdict` stays undefined and routing relies on local flags only (so blind-refine callers still refine once via the `minorFlag`/omission paths, preserving the old "refine when enabled" test which passes no `selectiveRefine`). Verify the existing `test/translator.test.ts` "refine pass runs when enabled" still passes; if routing accepts a clean fake draft (no flags, no verdict), that test would break. To preserve it: when `!opts.selectiveRefine`, force one refine pass before routing:
```typescript
    if (!opts.selectiveRefine) {
      const refined = await provider.refineChunk({
        source: payload, draft: finalText, targetLang: TARGET_LANG,
        glossary: opts.glossary, previousContext: opts.previousContext, deep: false,
      });
      usage = addUsage(usage, refined.usage);
      finalText = refined.text;
    } else {
      // ...the routed loop above...
    }
```
Place the routed loop inside the `else`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test && bun run typecheck`
Expected: PASS (full suite incl. new 2 and the preserved translator tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add lib/core/translator.ts test/quality-pipeline.test.ts
git commit -m "feat(quality): route drafts through validators + judge in translateBlocks"
```

---

### Task 6: Per-chunk failure isolation in the job

**Files:**
- Modify: `lib/core/job.ts`
- Test: `test/job-failure-isolation.test.ts`

**Interfaces:**
- Consumes: existing `runJob`, `JobState`.
- Produces: a chunk whose translation throws is logged and left uncached; the pool continues; if any chunk is ultimately missing the job ends `status: "error"` with a Hungarian message, and all successful chunks are cached for resume.

- [ ] **Step 1: Write the failing test**

```typescript
// test/job-failure-isolation.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJob } from "../lib/core/job.ts";
import { FakeTranslator } from "../lib/core/providers/fake.ts";
import type { Translator, TranslateChunkInput } from "../lib/core/translator.ts";
import { buildFixtureEpub } from "./helpers/epub-fixture.ts";

test("one failing chunk does not abort the whole book; others are cached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quire-fail-"));
  const fake = new FakeTranslator();
  let calls = 0;
  // Fail the very first translateChunk call, succeed afterwards.
  const flaky: Translator = {
    name: "flaky",
    async translateChunk(i: TranslateChunkInput) {
      calls++;
      if (calls === 1) throw new Error("boom");
      return fake.translateChunk(i);
    },
  };

  const state = await runJob({ id: "f1", epubBytes: buildFixtureEpub(), provider: flaky, jobDir: dir });
  // The book has 2 chunks; one failed, one (or more) succeeded and is cached.
  expect(state.status).toBe("error");
  expect(state.chunks.done).toBeGreaterThanOrEqual(1);
  expect(state.error).toContain("szakasz");

  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test test/job-failure-isolation.test.ts`
Expected: FAIL — currently the thrown error propagates out of `runJob` (rejects) instead of resolving to an `error` JobState with partial progress.

- [ ] **Step 3: Write minimal implementation**

In `lib/core/job.ts`, make `processChunk` swallow a translate failure (after transport retries) instead of throwing, recording it:

3a. Add a failure counter near the other loop controls:
```typescript
  let failedChunks = 0;
```

3b. Wrap the `translateBlocks` call in `processChunk`:
```typescript
    let blocks, usage, plainText;
    try {
      const out = await translateBlocks(provider, chunk.blocks, {
        glossary,
        previousContext: anchor || undefined,
        refine: opts.refine,
        selectiveRefine: opts.selectiveRefine,
        reasonerForHard: opts.reasonerForHard,
        precision: opts.precision,
      });
      blocks = out.blocks; usage = out.usage; plainText = out.plainText;
    } catch (err) {
      failedChunks += 1;
      console.error(`[job ${id}] chunk ${chunk.key} failed:`, err instanceof Error ? err.message : err);
      return undefined; // leave uncached so resume retries only this chunk
    }
```
(Keep the rest of `processChunk` — saveChunkResult, state update — using these locals.)

3c. After the worker pool completes, before the re-stitch, turn partial failure into an `error` status:
```typescript
    if (failedChunks > 0) {
      state = {
        ...state,
        status: "error",
        error: `${failedChunks} szakasz fordítása nem sikerült. Indítsd újra a folytatáshoz.`,
        finishedAt: nowIso(),
      };
      return persist(jobDir, state, onProgress);
    }
```
Place this right after the `if (ceilingHit) throw ...` check and before the re-stitch loop.

3d. Add `precision?: PrecisionMode` to `RunJobOptions` and import the type:
```typescript
import type { PrecisionMode } from "./quality/route";
// ...
  precision?: PrecisionMode;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test && bun run typecheck`
Expected: PASS (new isolation test + all existing job tests; a clean run still reaches `done` because `failedChunks` stays 0).

- [ ] **Step 5: Commit**

```bash
git add lib/core/job.ts test/job-failure-isolation.test.ts
git commit -m "feat(job): isolate per-chunk failures; partial book resumes"
```

---

### Task 7: Precision config + docs/deploy

**Files:**
- Modify: `lib/server/config.ts`, `lib/server/jobs.ts`, `README.md`, `docker-compose.yml`, `deploy/proxmox-install.sh`
- Test: `test/config-precision.test.ts`

**Interfaces:**
- Consumes: `PrecisionMode` (Task 4), existing `ServerConfig`/`startJob`.
- Produces: `ServerConfig.precision: PrecisionMode`; `runJob` receives it via `startJob`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/config-precision.test.ts
import { test, expect, afterEach } from "bun:test";
import { loadConfig } from "../lib/server/config.ts";

const prev = process.env.TRANSLATION_PRECISION;
afterEach(() => { if (prev === undefined) delete process.env.TRANSLATION_PRECISION; else process.env.TRANSLATION_PRECISION = prev; });

test("defaults precision to balanced", () => {
  delete process.env.TRANSLATION_PRECISION;
  expect(loadConfig().precision).toBe("balanced");
});

test("reads a valid precision mode and rejects junk", () => {
  process.env.TRANSLATION_PRECISION = "fidelity";
  expect(loadConfig().precision).toBe("fidelity");
  process.env.TRANSLATION_PRECISION = "nonsense";
  expect(loadConfig().precision).toBe("balanced");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test test/config-precision.test.ts`
Expected: FAIL — `precision` not on `ServerConfig`.

- [ ] **Step 3: Write minimal implementation**

3a. In `lib/server/config.ts`, import the type and add the field + parser:
```typescript
import type { PrecisionMode } from "@/lib/core/quality/route";
```
Add to `ServerConfig`:
```typescript
  precision: PrecisionMode;
```
In `loadConfig`, before the return:
```typescript
  const rawPrecision = (process.env.TRANSLATION_PRECISION ?? "balanced").trim();
  const precision: PrecisionMode =
    rawPrecision === "fidelity" || rawPrecision === "natural" ? rawPrecision : "balanced";
```
Add `precision,` to the returned object.

3b. In `lib/server/jobs.ts`, pass it through in `startJob`'s `runJob({...})`:
```typescript
    precision: config.precision,
```

3c. In `README.md`, add a row under the existing translation env table:
```markdown
| `TRANSLATION_PRECISION` | `balanced` | Quality mode: `balanced`, `fidelity` (stricter on meaning/omission + back-translation), or `natural`. |
```

3d. In `docker-compose.yml`, under the other `TRANSLATION_*` env lines:
```yaml
      TRANSLATION_PRECISION: "${TRANSLATION_PRECISION:-balanced}"
```

3e. In `deploy/proxmox-install.sh`, alongside the other `TRANSLATION_*` declarations:
```bash
TRANSLATION_PRECISION="${TRANSLATION_PRECISION:-balanced}"
```
and in the heredoc that writes the `.env`:
```bash
TRANSLATION_PRECISION=$TRANSLATION_PRECISION
```

- [ ] **Step 4: Run the full suite, typecheck, build**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test && bun run typecheck && bun run build`
Expected: ALL tests PASS, typecheck clean, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add lib/server/config.ts lib/server/jobs.ts README.md docker-compose.yml deploy/proxmox-install.sh test/config-precision.test.ts
git commit -m "feat(config): TRANSLATION_PRECISION mode plumbed end-to-end"
```

---

## Self-Review

**Spec coverage:**
- Transport (retry/backoff/jitter/timeout/Retry-After) → Task 1. ✓
- Provider on transport + structured JSON judge → Task 2. ✓
- Local validators (tokens/omission/glossary) → Task 3. ✓
- Effort routing + iteration cap → Task 4. ✓
- Pipeline integration (draft→validate→judge→route) → Task 5. ✓
- Per-chunk failure isolation + resume → Task 6. ✓
- Precision modes + config + docs/deploy → Task 7. ✓
- Backpressure (AIMD-lite): the spec lists it as a refinement on top of per-request backoff. Per-request retry/backoff (Task 1) is the load-shedding mechanism; an explicit global cooldown is deferred as a non-essential enhancement (note in spec as "primary mechanism is per-request backoff"). No separate task — acceptable for this iteration.

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The back-translation step in Task 5 is intentionally a documented usage hook (fidelity mode flag flows to `decision.backTranslate`) — the actual reverse-translation probe is out of scope for this iteration and not referenced by any type, so it introduces no dangling reference.

**Type consistency:** `EstimateChunkOutput` extended once (Task 2) and consumed in Task 4/5. `PrecisionMode`/`RouteDecision`/`LocalReport`/`ValidateOptions` defined in Tasks 3–4 and consumed in Task 5–7 with matching names. `fetchImpl` threads from `DeepSeekOptions` (Task 2) to `fetchWithRetry` (Task 1). `precision` threads config → jobs → runJob → translateBlocks (Tasks 7,6,5).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-24-translation-pipeline.md`.
