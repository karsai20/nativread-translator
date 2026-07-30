import { test, expect } from "bun:test";
import { OpenAICompatibleTranslator } from "../lib/core/providers/openai-compatible.ts";

function fetchReturning(payloads: unknown[], seenBodies: unknown[] = []): typeof fetch {
  let i = 0;
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === "string") seenBodies.push(JSON.parse(init.body));
    const body = JSON.stringify(payloads[Math.min(i, payloads.length - 1)]);
    i++;
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("OpenAI-compatible adapter parses JSON quality verdicts", async () => {
  const fake = fetchReturning([
    {
      choices: [{ message: { content: '{"score":2,"omission":true,"accuracy":false,"fluency":true}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    },
  ]);
  const t = new OpenAICompatibleTranslator({ apiKey: "k", model: "test-model", fetchImpl: fake });

  const v = await t.estimateChunk({ source: "s", draft: "d", targetLang: "Hungarian", glossary: {} });

  expect(v.score).toBe(2);
  expect(v.omission).toBe(true);
  expect(v.needsRefine).toBe(true);
  expect(v.hard).toBe(true);
  expect(v.usage?.inputTokens).toBe(10);
});

test("OpenAI-compatible adapter uses the configured model and response_format", async () => {
  const bodies: unknown[] = [];
  const fake = fetchReturning([
    { choices: [{ message: { content: '{"score":5,"omission":false,"accuracy":false,"fluency":false}' } }] },
  ], bodies);
  const t = new OpenAICompatibleTranslator({ apiKey: "k", model: "configured-model", fetchImpl: fake });

  await t.estimateChunk({ source: "s", draft: "d", targetLang: "Hungarian", glossary: {} });

  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({
    model: "configured-model",
    response_format: { type: "json_object" },
  });
});

test("reasoning_effort is sent on normal calls but never on the reasoner model", async () => {
  const bodies: unknown[] = [];
  const fake = fetchReturning([{ choices: [{ message: { content: "kész" } }] }], bodies);
  const t = new OpenAICompatibleTranslator({
    apiKey: "k",
    model: "flash",
    reasonerModel: "thinky",
    reasoningEffort: "none",
    fetchImpl: fake,
  });

  await t.translateChunk({ text: "x", sourceLang: "English", targetLang: "Hungarian", glossary: {} });
  await t.refineChunk({ source: "x", draft: "y", targetLang: "Hungarian", glossary: {}, deep: true });

  expect(bodies[0]).toMatchObject({ model: "flash", reasoning_effort: "none" });
  expect(bodies[1]).toMatchObject({ model: "thinky" });
  expect(bodies[1]).not.toHaveProperty("reasoning_effort");
});

test("thinking config is sent on normal calls but never on the reasoner model", async () => {
  const bodies: unknown[] = [];
  const fake = fetchReturning([{ choices: [{ message: { content: "kész" } }] }], bodies);
  const thinkingBody = { extra_body: { google: { thinking_config: { thinking_level: "minimal" } } } };
  const t = new OpenAICompatibleTranslator({
    apiKey: "k",
    model: "flash",
    reasonerModel: "thinky",
    thinkingBody,
    fetchImpl: fake,
  });

  await t.translateChunk({ text: "x", sourceLang: "English", targetLang: "Hungarian", glossary: {} });
  await t.refineChunk({ source: "x", draft: "y", targetLang: "Hungarian", glossary: {}, deep: true });

  expect(bodies[0]).toMatchObject(thinkingBody);
  // The escalation model is chosen for its reasoning — suppressing it there is self-defeating.
  expect(bodies[1]).not.toHaveProperty("extra_body");
});

test("reports provider-cached input tokens so cost is not overstated", async () => {
  const fake = fetchReturning([
    {
      choices: [{ message: { content: "kész" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 700 } },
    },
  ]);
  const t = new OpenAICompatibleTranslator({ apiKey: "k", model: "flash", fetchImpl: fake });

  const out = await t.translateChunk({ text: "x", sourceLang: "English", targetLang: "Hungarian", glossary: {} });

  expect(out.usage?.cachedInputTokens).toBe(700);
});
