// Probe: which body shape actually turns Gemini's thinking down on this model?
//
//   bun run eval:probe [model]            (default: gemini-3.6-flash)
//
// The docs describe thinking control through the OpenAI *SDK* (`reasoning_effort`, and
// `extra_body` -> google.thinking_config). We send raw JSON, so the SDK's nesting is a
// guess until measured. This prints the raw usage block per shape: whichever shape drops
// the thought/output token count is the one to wire into config.ts — and a 400 tells us
// the shape is wrong, which is exactly what we want to learn before shipping it.

export {}; // top-level await needs this file to be a module

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MODEL = process.argv[2] ?? "gemini-3.6-flash";
const PROMPT = "Translate to Hungarian, output only the translation: 'The old lighthouse keeper counted the waves.'";

const SHAPES: { name: string; extra: Record<string, unknown> }[] = [
  { name: "baseline (no control)", extra: {} },
  { name: "reasoning_effort: none", extra: { reasoning_effort: "none" } },
  { name: "reasoning_effort: low", extra: { reasoning_effort: "low" } },
  {
    name: "extra_body.google.thinking_config",
    extra: { extra_body: { google: { thinking_config: { thinking_level: "minimal" } } } },
  },
  {
    name: "google.thinking_config (top level)",
    extra: { google: { thinking_config: { thinking_level: "minimal" } } },
  },
];

const apiKey = (process.env.PROVIDER_API_KEY ?? process.env.GEMINI_API_KEY ?? "").trim();
if (!apiKey) {
  console.error("PROVIDER_API_KEY (or GEMINI_API_KEY) is required.");
  process.exit(1);
}

console.log(`model: ${MODEL}\n`);

for (const shape of SHAPES) {
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      ...shape.extra,
      model: MODEL,
      temperature: 0.5,
      max_tokens: 2048,
      messages: [{ role: "user", content: PROMPT }],
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.log(`✗ ${shape.name}: HTTP ${res.status} — ${text.slice(0, 200).replace(/\s+/g, " ")}\n`);
    continue;
  }

  const json = JSON.parse(text) as {
    usage?: Record<string, unknown>;
    choices?: { message?: { content?: string } }[];
  };
  console.log(`✓ ${shape.name}`);
  console.log(`  usage: ${JSON.stringify(json.usage)}`);
  console.log(`  text : ${(json.choices?.[0]?.message?.content ?? "").slice(0, 80)}\n`);
}

console.log(
  "A legkevesebb output/thought tokent adó, hibátlan alak megy a config.ts-be.\n" +
    "Ha a baseline és a 'none' azonos, a paraméter nem érvényesül — akkor a másik alak kell.",
);
