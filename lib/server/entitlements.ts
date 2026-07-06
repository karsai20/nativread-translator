import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ServerConfig } from "./config";

export interface TranslationEntitlement {
  userId: string;
  sourceHash: string;
  transactionId: string;
  productId: string;
  createdAt: string;
}

export interface GrantTranslationEntitlementInput {
  userId: string;
  sourceHash: string;
  transactionId: string;
  productId: string;
}

function safeSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function userSourcePath(config: ServerConfig, userId: string, sourceHash: string): string {
  return join(config.entitlementsDir, "users", safeSegment(userId), `${sourceHash}.json`);
}

function transactionPath(config: ServerConfig, transactionId: string): string {
  return join(config.entitlementsDir, "transactions", `${safeSegment(transactionId)}.json`);
}

function readEntitlement(path: string): TranslationEntitlement | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TranslationEntitlement;
  } catch {
    return undefined;
  }
}

export function hasTranslationEntitlement(
  config: ServerConfig,
  userId: string,
  sourceHash: string,
): boolean {
  return Boolean(readEntitlement(userSourcePath(config, userId, sourceHash)));
}

export function grantTranslationEntitlement(
  config: ServerConfig,
  input: GrantTranslationEntitlementInput,
): TranslationEntitlement {
  const byTransaction = transactionPath(config, input.transactionId);
  const existing = readEntitlement(byTransaction);
  if (existing) return existing;

  const entitlement: TranslationEntitlement = {
    userId: input.userId,
    sourceHash: input.sourceHash,
    transactionId: input.transactionId,
    productId: input.productId,
    createdAt: new Date().toISOString(),
  };

  const byUserSource = userSourcePath(config, input.userId, input.sourceHash);
  mkdirSync(join(config.entitlementsDir, "transactions"), { recursive: true });
  mkdirSync(join(config.entitlementsDir, "users", safeSegment(input.userId)), { recursive: true });
  try {
    writeFileSync(byTransaction, JSON.stringify(entitlement, null, 2), { flag: "wx" });
  } catch (err) {
    const raced = readEntitlement(byTransaction);
    if (raced) return raced;
    throw err;
  }
  writeFileSync(byUserSource, JSON.stringify(entitlement, null, 2));
  return entitlement;
}
