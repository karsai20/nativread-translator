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

test("translation entitlements are scoped by user and source hash", () => {
  const dir = mkdtempSync(join(tmpdir(), "quire-entitlements-"));
  const config = testConfig(dir);
  const sourceHash = "a".repeat(64);

  grantTranslationEntitlement(config, {
    userId: "user-a",
    sourceHash,
    transactionId: "txn-1",
    productId: "nativread.translate.under100",
  });

  expect(hasTranslationEntitlement(config, "user-a", sourceHash)).toBe(true);
  expect(hasTranslationEntitlement(config, "user-b", sourceHash)).toBe(false);
  expect(hasTranslationEntitlement(config, "user-a", "b".repeat(64))).toBe(false);

  rmSync(dir, { recursive: true, force: true });
});

test("transaction ids are idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "quire-entitlements-"));
  const config = testConfig(dir);

  const first = grantTranslationEntitlement(config, {
    userId: "user-a",
    sourceHash: "a".repeat(64),
    transactionId: "txn-1",
    productId: "nativread.translate.under100",
  });
  const second = grantTranslationEntitlement(config, {
    userId: "user-a",
    sourceHash: "b".repeat(64),
    transactionId: "txn-1",
    productId: "nativread.translate.under100",
  });

  expect(second).toEqual(first);

  rmSync(dir, { recursive: true, force: true });
});
