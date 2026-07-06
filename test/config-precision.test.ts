import { test, expect, afterEach } from "bun:test";
import { loadConfig } from "../lib/server/config.ts";

const prev = process.env.TRANSLATION_PRECISION;
const prevProvider = process.env.TRANSLATION_PROVIDER;
const prevProviderKey = process.env.PROVIDER_API_KEY;
const prevOpenAiKey = process.env.OPENAI_API_KEY;
const prevGeminiKey = process.env.GEMINI_API_KEY;
const prevDeepSeekKey = process.env.DEEPSEEK_API_KEY;
const prevModel = process.env.PROVIDER_MODEL;
afterEach(() => {
  if (prev === undefined) delete process.env.TRANSLATION_PRECISION;
  else process.env.TRANSLATION_PRECISION = prev;
  if (prevProvider === undefined) delete process.env.TRANSLATION_PROVIDER;
  else process.env.TRANSLATION_PROVIDER = prevProvider;
  if (prevProviderKey === undefined) delete process.env.PROVIDER_API_KEY;
  else process.env.PROVIDER_API_KEY = prevProviderKey;
  if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevOpenAiKey;
  if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = prevGeminiKey;
  if (prevDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = prevDeepSeekKey;
  if (prevModel === undefined) delete process.env.PROVIDER_MODEL;
  else process.env.PROVIDER_MODEL = prevModel;
});

function clearProviderEnv(): void {
  delete process.env.TRANSLATION_PROVIDER;
  delete process.env.PROVIDER_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.PROVIDER_MODEL;
}

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

test("defaults to fake without a provider key", () => {
  clearProviderEnv();
  expect(loadConfig().providerName).toBe("fake");
});

test("infers OpenAI from PROVIDER_API_KEY unless provider is explicit", () => {
  clearProviderEnv();
  process.env.PROVIDER_API_KEY = "k";
  process.env.PROVIDER_MODEL = "m";
  expect(loadConfig().providerName).toBe("openai");

  process.env.TRANSLATION_PROVIDER = "deepseek";
  expect(loadConfig().providerName).toBe("deepseek");
});
