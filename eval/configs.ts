// The configurations the eval puts head to head. Edit this list, not run.ts.
//
// Every knob that today is an unmeasured guess belongs here: model tier, thinking level,
// temperature, refine policy. The judge that SCORES the runs is fixed separately (see
// JUDGE_MODEL in run.ts) — scoring must not move with the thing being scored.

export interface EvalConfig {
  /** Short id; also the output filename. */
  name: string;
  model: string;
  /** Gemini 2.5 family: "none" disables thinking. Unset = provider default. */
  reasoningEffort?: string;
  /** Gemini 3.x family: the wire shape verified by `bun run eval:probe`. */
  thinkingBody?: Record<string, unknown>;
  temperature?: number;
  refine: boolean;
  selectiveRefine: boolean;
  /** Model the hardest chunks escalate to; unset means no escalation happens. */
  reasonerModel?: string;
  /**
   * Resolve every seeded name's Hungarian rendering up front (one extra call), the way a
   * real job does, instead of leaving each chunk to decide on its own.
   */
  prefillGlossary?: boolean;
}

/** Measured on gemini-3.6-flash: 731 thinking tokens for a one-sentence translation. */
const MINIMAL_THINKING = {
  extra_body: { google: { thinking_config: { thinking_level: "minimal" } } },
};

export const CONFIGS: EvalConfig[] = [
  {
    // Today's shipping default, as the baseline everything else must beat.
    name: "baseline-2.5-flash",
    model: "gemini-2.5-flash",
    reasoningEffort: "none",
    temperature: 0.5,
    refine: true,
    selectiveRefine: true,
  },
  {
    // Same list price as the baseline, a generation and a half newer.
    name: "3.5-flash-lite",
    model: "gemini-3.5-flash-lite",
    thinkingBody: MINIMAL_THINKING,
    temperature: 0.5,
    refine: true,
    selectiveRefine: true,
  },
  {
    // Cheaper than the baseline on both input and output.
    name: "3.1-flash-lite",
    model: "gemini-3.1-flash-lite",
    thinkingBody: MINIMAL_THINKING,
    temperature: 0.5,
    refine: true,
    selectiveRefine: true,
  },
  {
    // Premium tier. Only worth it if the text is visibly better — that is what the
    // side-by-side output is for.
    name: "3.6-flash",
    model: "gemini-3.6-flash",
    thinkingBody: MINIMAL_THINKING,
    temperature: 0.5,
    refine: true,
    selectiveRefine: true,
  },
  {
    // Does a colder draft omit less without going wooden?
    name: "3.5-flash-lite-t02",
    model: "gemini-3.5-flash-lite",
    thinkingBody: MINIMAL_THINKING,
    temperature: 0.2,
    refine: true,
    selectiveRefine: true,
  },
  {
    // What does the second pass actually buy? Draft only, same model as the tier above.
    name: "3.5-flash-lite-norefine",
    model: "gemini-3.5-flash-lite",
    thinkingBody: MINIMAL_THINKING,
    temperature: 0.5,
    refine: false,
    selectiveRefine: false,
  },
];

/** Round 2: does the up-front glossary pass fix the proper-name drift we saw in round 1? */
CONFIGS.push(
  {
    name: "3.1-lite-prefill",
    model: "gemini-3.1-flash-lite",
    thinkingBody: MINIMAL_THINKING,
    temperature: 0.5,
    refine: true,
    selectiveRefine: true,
    prefillGlossary: true,
  },
  {
    name: "3.6-flash-prefill",
    model: "gemini-3.6-flash",
    thinkingBody: MINIMAL_THINKING,
    temperature: 0.5,
    refine: true,
    selectiveRefine: true,
    prefillGlossary: true,
  },
);
