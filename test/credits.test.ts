import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../lib/server/config.ts";
import {
  CreditLedgerError,
  InsufficientCreditsError,
  creditAccount,
  grantCreditPurchase,
  reserveCredits,
  settleCreditReservation,
} from "../lib/server/credits.ts";
import { deleteJob } from "../lib/server/jobs.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nativread-credits-"));
  process.env.ENTITLEMENTS_DIR = root;
});

afterEach(() => {
  delete process.env.ENTITLEMENTS_DIR;
  rmSync(root, { recursive: true, force: true });
});

test("credit purchase and reservation are idempotent and settle on delivery", () => {
  const config = loadConfig();
  const purchase = {
    userId: "apple:user-a",
    transactionId: "storekit-1",
    productId: "com.karsai.nativread.credits.250",
  };
  expect(grantCreditPurchase(config, purchase).applied).toBe(true);
  expect(grantCreditPurchase(config, purchase).applied).toBe(false);
  expect(creditAccount(config, purchase.userId).balance).toBe(250);

  const reservation = {
    jobId: "job-a",
    userId: purchase.userId,
    sourceHash: "a".repeat(64),
    credits: 120,
    quoteVersion: "source-chars-v1",
  };
  expect(reserveCredits(config, reservation).applied).toBe(true);
  expect(reserveCredits(config, reservation).applied).toBe(false);
  expect(creditAccount(config, purchase.userId)).toMatchObject({
    balance: 130,
    reservedCredits: 120,
    spentCredits: 0,
  });

  settleCreditReservation(config, reservation.jobId, "finalized");
  expect(creditAccount(config, purchase.userId)).toMatchObject({
    balance: 130,
    reservedCredits: 0,
    spentCredits: 120,
  });
});

test("refund restores reserved credits and insufficient balances fail closed", () => {
  const config = loadConfig();
  grantCreditPurchase(config, {
    userId: "apple:user-a",
    transactionId: "storekit-1",
    productId: "com.karsai.nativread.credits.250",
  });
  reserveCredits(config, {
    jobId: "job-a",
    userId: "apple:user-a",
    sourceHash: "a".repeat(64),
    credits: 200,
    quoteVersion: "source-chars-v1",
  });
  settleCreditReservation(config, "job-a", "refunded");
  expect(creditAccount(config, "apple:user-a").balance).toBe(250);

  expect(() => reserveCredits(config, {
    jobId: "job-b",
    userId: "apple:user-a",
    sourceHash: "b".repeat(64),
    credits: 251,
    quoteVersion: "source-chars-v1",
  })).toThrow(InsufficientCreditsError);
});

test("a StoreKit transaction cannot be rebound to another account", () => {
  const config = loadConfig();
  grantCreditPurchase(config, {
    userId: "apple:user-a",
    transactionId: "storekit-1",
    productId: "com.karsai.nativread.credits.250",
  });
  expect(() => grantCreditPurchase(config, {
    userId: "apple:user-b",
    transactionId: "storekit-1",
    productId: "com.karsai.nativread.credits.250",
  })).toThrow(CreditLedgerError);
  expect(creditAccount(config, "apple:user-b").balance).toBe(0);
});

test("deleting an undelivered job refunds its reserved credits", () => {
  const config = loadConfig();
  grantCreditPurchase(config, {
    userId: "apple:user-a",
    transactionId: "storekit-1",
    productId: "com.karsai.nativread.credits.250",
  });
  reserveCredits(config, {
    jobId: "job-a",
    userId: "apple:user-a",
    sourceHash: "a".repeat(64),
    credits: 200,
    quoteVersion: "source-chars-v1",
  });
  expect(creditAccount(config, "apple:user-a").balance).toBe(50);

  deleteJob(config, "job-a");
  expect(creditAccount(config, "apple:user-a").balance).toBe(250);
});
