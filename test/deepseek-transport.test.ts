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
