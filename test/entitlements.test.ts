import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  grantTranslationEntitlement,
  hasTranslationEntitlement,
} from "../lib/server/entitlements.ts";
import type { ServerConfig } from "../lib/server/config.ts";

function testConfig(entitlementsDir: string): ServerConfig {
  return {
    jobsDir: join(entitlementsDir, "jobs"),
    libraryDir: join(entitlementsDir, "library"),
    entitlementsDir,
    costCeilingUsd: 10,
    apiKey: "",
    providerName: "fake",
    refine: false,
    refineSelective: false,
    reasonerForHard: false,
    precision: "balanced",
    concurrency: 1,
    requireFullTranslationEntitlements: true,
    allowUnsignedStoreKitGrants: true,
  };
}

test("translation entitlements are scoped by user, source hash and language", () => {
  const dir = mkdtempSync(join(tmpdir(), "quire-entitlements-"));
  const config = testConfig(dir);
  const sourceHash = "a".repeat(64);

  grantTranslationEntitlement(config, {
    userId: "user-a",
    sourceHash,
    targetLanguage: "hu",
    transactionId: "txn-1",
    productId: "nativread.translate.under100",
  });

  expect(hasTranslationEntitlement(config, "user-a", sourceHash, "hu")).toBe(true);
  expect(hasTranslationEntitlement(config, "user-b", sourceHash, "hu")).toBe(false);
  expect(hasTranslationEntitlement(config, "user-a", "b".repeat(64), "hu")).toBe(false);
  // eng D9: a Hungarian purchase must not unlock the German translation
  // of the same book.
  expect(hasTranslationEntitlement(config, "user-a", sourceHash, "de")).toBe(false);

  rmSync(dir, { recursive: true, force: true });
});

test("the same book can be bought per language without collision", () => {
  const dir = mkdtempSync(join(tmpdir(), "quire-entitlements-"));
  const config = testConfig(dir);
  const sourceHash = "a".repeat(64);

  grantTranslationEntitlement(config, {
    userId: "user-a",
    sourceHash,
    targetLanguage: "hu",
    transactionId: "txn-1",
    productId: "nativread.translate.under100",
  });
  grantTranslationEntitlement(config, {
    userId: "user-a",
    sourceHash,
    targetLanguage: "de",
    transactionId: "txn-2",
    productId: "nativread.translate.under100",
  });

  expect(hasTranslationEntitlement(config, "user-a", sourceHash, "hu")).toBe(true);
  expect(hasTranslationEntitlement(config, "user-a", sourceHash, "de")).toBe(true);
  expect(hasTranslationEntitlement(config, "user-a", sourceHash, "es")).toBe(false);

  rmSync(dir, { recursive: true, force: true });
});

test("transaction ids are idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "quire-entitlements-"));
  const config = testConfig(dir);

  const first = grantTranslationEntitlement(config, {
    userId: "user-a",
    sourceHash: "a".repeat(64),
    targetLanguage: "hu",
    transactionId: "txn-1",
    productId: "nativread.translate.under100",
  });
  const second = grantTranslationEntitlement(config, {
    userId: "user-a",
    sourceHash: "b".repeat(64),
    targetLanguage: "de",
    transactionId: "txn-1",
    productId: "nativread.translate.under100",
  });

  expect(second).toEqual(first);

  rmSync(dir, { recursive: true, force: true });
});
