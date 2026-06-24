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
