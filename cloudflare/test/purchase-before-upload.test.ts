import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { sqliteD1 } from "./d1";
import { applyMigrations } from "./migrations";

import { UserDataRepository, bookTierForProduct, entitlementStands, paidTierCovers } from "../src/database";
import { parsePurchaseRequest } from "../src/purchase-request";
import { HttpError } from "../src/security";

const USER_A = "a".repeat(64);
const USER_B = "b".repeat(64);
const BOOK = "1".repeat(64);
const OTHER_BOOK = "2".repeat(64);

let database: Database;
let d1: D1Database;

beforeEach(async () => {
  database = new Database(":memory:", { strict: true });
  await applyMigrations(database);
  d1 = sqliteD1(database);
  const now = new Date().toISOString();
  for (const user of [USER_A, USER_B]) {
    database.query("INSERT INTO accounts VALUES (?, ?, ?)").run(user, now, now);
    database.query("INSERT INTO credit_accounts VALUES (?, 100, 0, 0, ?)").run(user, now);
  }
});

afterEach(() => database.close());

function purchase(transactionId: string, tier = 3) {
  return {
    transactionId,
    productId: `com.karsai.nativread.book.t${tier}`,
    environment: "Sandbox" as const,
  };
}

describe("a purchase made before the book is uploaded", () => {
  test("entitles the account to that book in that language only", async () => {
    const reader = new UserDataRepository(d1, USER_A);

    expect(await reader.recordBookPurchaseFor(BOOK, "de", purchase("t-1")))
      .toEqual({ applied: true });

    expect(await reader.entitled(BOOK, "de")).toBe(true);
    expect(await reader.entitled(BOOK, "hu")).toBe(false);
    expect(await reader.entitled(OTHER_BOOK, "de")).toBe(false);
    expect(await reader.entitledLanguages(BOOK)).toEqual(["de"]);
  });

  test("a replayed receipt is a no-op, another account's claim is a conflict", async () => {
    const reader = new UserDataRepository(d1, USER_A);
    const other = new UserDataRepository(d1, USER_B);
    await reader.recordBookPurchaseFor(BOOK, "hu", purchase("t-2"));

    expect(await reader.recordBookPurchaseFor(BOOK, "hu", purchase("t-2")))
      .toEqual({ applied: false });
    expect(await other.recordBookPurchaseFor(BOOK, "hu", purchase("t-2")))
      .toEqual({ applied: false, conflict: true });
    expect(await reader.recordBookPurchaseFor(OTHER_BOOK, "hu", purchase("t-2")))
      .toEqual({ applied: false, conflict: true });
    expect(await reader.recordBookPurchaseFor(BOOK, "de", purchase("t-2")))
      .toEqual({ applied: false, conflict: true });
    expect(await other.entitled(BOOK, "hu")).toBe(false);
  });

  test("names the tier it paid for, the highest when bought more than once", async () => {
    const reader = new UserDataRepository(d1, USER_A);
    expect(await reader.paidTier(BOOK, "hu")).toBeNull();

    await reader.recordBookPurchaseFor(BOOK, "hu", purchase("t-3", 2));
    await reader.recordBookPurchaseFor(BOOK, "hu", purchase("t-4", 4));

    expect(await reader.paidTier(BOOK, "hu")).toBe(4);
    expect(await reader.paidTier(BOOK, "de")).toBeNull();
  });
});

describe("whether a paid tier covers the book the server counted", () => {
  test("the paid tier or one below the server's count is honoured", () => {
    expect(paidTierCovers(3, 3)).toBe(true);
    expect(paidTierCovers(4, 3)).toBe(true);
    // The device and server counters are pinned together; a book right on a
    // tier boundary may still land one tier apart, and the reader keeps the
    // price they were shown.
    expect(paidTierCovers(2, 3)).toBe(true);
  });

  test("a tier bought for a much longer book is refused", () => {
    expect(paidTierCovers(1, 3)).toBe(false);
    expect(paidTierCovers(1, 8)).toBe(false);
  });

  test("maps product ids back to their tier", () => {
    expect(bookTierForProduct("com.karsai.nativread.book.t5")?.tier).toBe(5);
    expect(bookTierForProduct("com.karsai.nativread.book.t9")).toBeUndefined();
    expect(bookTierForProduct("com.example.other")).toBeUndefined();
  });
});

describe("a full translation may start", () => {
  test("only with an entitlement for that book and language", () => {
    expect(entitlementStands({ entitled: false, paidTier: null, serverTier: 3 })).toBe(false);
    expect(entitlementStands({ entitled: true, paidTier: 3, serverTier: 3 })).toBe(true);
  });

  test("an entitlement granted without a purchase stands for any length", () => {
    expect(entitlementStands({ entitled: true, paidTier: null, serverTier: 8 })).toBe(true);
  });

  test("a purchase too far below the server's tier does not", () => {
    expect(entitlementStands({ entitled: true, paidTier: 1, serverTier: 4 })).toBe(false);
  });
});

describe("POST /api/purchase body", () => {
  const transactionId = "2000000900000001";

  test("the legacy shape names an uploaded job", () => {
    expect(parsePurchaseRequest({ id: "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a0a1", transactionId }))
      .toEqual({ kind: "job", id: "018f6f4d-90a7-7d8f-8f9a-1d4cf6b9a0a1", transactionId });
  });

  test("the pre-upload shape names the book, language and product", () => {
    expect(parsePurchaseRequest({
      sourceHash: BOOK, targetLanguage: "de",
      productId: "com.karsai.nativread.book.t2", transactionId,
    })).toEqual({
      kind: "book", sourceHash: BOOK, targetLanguage: "de",
      productId: "com.karsai.nativread.book.t2", transactionId,
    });
  });

  test("rejects anything it cannot trust the shape of", () => {
    const book = { sourceHash: BOOK, targetLanguage: "de", productId: "com.karsai.nativread.book.t2", transactionId };
    for (const bad of [
      {},
      { transactionId },
      { id: "not-a-uuid", transactionId },
      { ...book, transactionId: "has spaces" },
      { ...book, sourceHash: "ABC" },
      { ...book, targetLanguage: "xx" },
      { ...book, productId: "com.karsai.nativread.book.t9" },
    ]) {
      expect(() => parsePurchaseRequest(bad)).toThrow(HttpError);
    }
  });
});
