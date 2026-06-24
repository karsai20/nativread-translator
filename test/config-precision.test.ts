import { test, expect, afterEach } from "bun:test";
import { loadConfig } from "../lib/server/config.ts";

const prev = process.env.TRANSLATION_PRECISION;
afterEach(() => {
  if (prev === undefined) delete process.env.TRANSLATION_PRECISION;
  else process.env.TRANSLATION_PRECISION = prev;
});

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
