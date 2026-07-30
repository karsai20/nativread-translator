import { describe, expect, test } from "bun:test";
import { SignJWT, exportPKCS8, generateKeyPair } from "jose";

import { bookTierFor } from "../src/database";
import { HttpError, appAccountTokenFor } from "../src/security";
import { appStoreTransaction, transactionRejection } from "../src/storekit";
import type { AppStoreTransaction } from "../src/storekit";
import type { Env } from "../src/types";

const BUNDLE_ID = "com.karsai.nativread";
const USER_ID = "ab12cd34ef56ab78cd90ef12ab34cd56" + "f".repeat(32);

async function testEnv(): Promise<Env> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return {
    APP_STORE_ISSUER_ID: "57246542-96fe-1a63-e053-0824d011072a",
    APP_STORE_KEY_ID: "2X9R4HXF34",
    APP_STORE_PRIVATE_KEY: await exportPKCS8(privateKey),
    APP_STORE_BUNDLE_ID: BUNDLE_ID,
  } as Env;
}

/** A stand-in for the JWS Apple returns; only the payload is ever read. */
async function signedTransaction(claims: Record<string, unknown>): Promise<string> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return new SignJWT({
    transactionId: "2000000900000001",
    productId: "com.karsai.nativread.book.t3",
    bundleId: BUNDLE_ID,
    type: "Consumable",
    appAccountToken: appAccountTokenFor(USER_ID),
    environment: "Sandbox",
    ...claims,
  }).setProtectedHeader({ alg: "ES256" }).sign(privateKey);
}

function fetcherReturning(
  responses: { status: number; body?: unknown }[],
  seenUrls: string[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seenUrls.push(String(input));
    const next = responses.shift() ?? { status: 500 };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("book pricing tiers", () => {
  test("picks the first tier a book fits into", () => {
    expect(bookTierFor(1)?.productId).toBe("com.karsai.nativread.book.t1");
    expect(bookTierFor(150_000)?.tier).toBe(1);
    expect(bookTierFor(150_001)?.tier).toBe(2);
    expect(bookTierFor(2_400_000)?.tier).toBe(6);
  });

  test("refuses a book longer than the top tier covers", () => {
    expect(bookTierFor(3_000_000)?.tier).toBe(6);
    expect(bookTierFor(3_000_001)).toBeUndefined();
  });
});

describe("App Store transaction lookup", () => {
  test("returns the transaction the production host knows", async () => {
    const seenUrls: string[] = [];
    const transaction = await appStoreTransaction(
      "2000000900000001",
      await testEnv(),
      fetcherReturning(
        [{ status: 200, body: { signedTransactionInfo: await signedTransaction({ environment: "Production" }) } }],
        seenUrls,
      ),
    );

    expect(seenUrls).toEqual([
      "https://api.storekit.itunes.apple.com/inApps/v1/transactions/2000000900000001",
    ]);
    expect(transaction.environment).toBe("Production");
    expect(transaction.productId).toBe("com.karsai.nativread.book.t3");
    expect(transaction.revoked).toBe(false);
  });

  test("falls back to the sandbox host when production does not know the id", async () => {
    const seenUrls: string[] = [];
    const transaction = await appStoreTransaction(
      "2000000900000001",
      await testEnv(),
      fetcherReturning(
        [
          { status: 404 },
          { status: 200, body: { signedTransactionInfo: await signedTransaction({}) } },
        ],
        seenUrls,
      ),
    );

    expect(seenUrls).toHaveLength(2);
    expect(seenUrls[1]).toContain("api.storekit-sandbox.itunes.apple.com");
    expect(transaction.environment).toBe("Sandbox");
    expect(transaction.appAccountToken).toBe(appAccountTokenFor(USER_ID));
  });

  test("rejects a transaction id neither host knows", async () => {
    await expect(appStoreTransaction(
      "2000000900000001",
      await testEnv(),
      fetcherReturning([{ status: 404 }, { status: 404 }]),
    )).rejects.toThrow(HttpError);
  });

  test("reports a rejected API key as a server configuration fault, not a bad receipt", async () => {
    const failure = await appStoreTransaction(
      "2000000900000001",
      await testEnv(),
      fetcherReturning([{ status: 401 }]),
    ).catch((error: unknown) => error as HttpError);

    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).status).toBe(503);
  });

  test("surfaces a revoked transaction so a refunded purchase cannot be spent", async () => {
    const transaction = await appStoreTransaction(
      "2000000900000001",
      await testEnv(),
      fetcherReturning([{
        status: 200,
        body: { signedTransactionInfo: await signedTransaction({ revocationDate: 1_753_000_000_000 }) },
      }]),
    );

    expect(transaction.revoked).toBe(true);
  });

  test("refuses to run without App Store credentials", async () => {
    await expect(appStoreTransaction(
      "2000000900000001",
      { APP_STORE_BUNDLE_ID: BUNDLE_ID } as Env,
      fetcherReturning([{ status: 200 }]),
    )).rejects.toThrow("nincs beállítva");
  });
});

describe("spending a verified transaction", () => {
  const valid: AppStoreTransaction = {
    transactionId: "2000000900000001",
    productId: "com.karsai.nativread.book.t3",
    bundleId: BUNDLE_ID,
    type: "Consumable",
    appAccountToken: appAccountTokenFor(USER_ID),
    environment: "Production",
    revoked: false,
  };
  const expected = {
    bundleId: BUNDLE_ID,
    productId: "com.karsai.nativread.book.t3",
    appAccountToken: appAccountTokenFor(USER_ID),
    requireProduction: true,
  };

  test("accepts a matching production transaction", () => {
    expect(transactionRejection(valid, expected)).toBeUndefined();
  });

  test("refuses a free sandbox purchase on a paying deployment", () => {
    expect(transactionRejection({ ...valid, environment: "Sandbox" }, expected))
      .toBe("environment");
    // The same receipt is what a staging deployment is meant to run on.
    expect(transactionRejection(
      { ...valid, environment: "Sandbox" },
      { ...expected, requireProduction: false },
    )).toBeUndefined();
  });

  test("refuses another app's, another account's, a revoked and a cheaper receipt", () => {
    expect(transactionRejection({ ...valid, bundleId: "com.other.app" }, expected)).toBe("bundle");
    expect(transactionRejection({ ...valid, type: "Auto-Renewable Subscription" }, expected)).toBe("type");
    expect(transactionRejection({ ...valid, revoked: true }, expected)).toBe("revoked");
    expect(transactionRejection({ ...valid, appAccountToken: appAccountTokenFor("0".repeat(64)) }, expected))
      .toBe("account");
    expect(transactionRejection({ ...valid, appAccountToken: undefined }, expected)).toBe("account");
    expect(transactionRejection({ ...valid, productId: "com.karsai.nativread.book.t1" }, expected))
      .toBe("tier");
  });
});

describe("purchase account binding", () => {
  test("derives a stable UUID per account and a different one per account", () => {
    expect(appAccountTokenFor(USER_ID)).toBe("ab12cd34-ef56-ab78-cd90-ef12ab34cd56");
    expect(appAccountTokenFor(USER_ID)).toBe(appAccountTokenFor(USER_ID));
    expect(appAccountTokenFor("0".repeat(64))).not.toBe(appAccountTokenFor(USER_ID));
  });
});
