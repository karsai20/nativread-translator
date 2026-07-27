import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { ServerConfig } from "./config";

export const CREDIT_PRODUCTS = [
  { productId: "com.karsai.nativread.credits.250", credits: 250 },
  { productId: "com.karsai.nativread.credits.600", credits: 600 },
  { productId: "com.karsai.nativread.credits.1200", credits: 1_200 },
] as const;

export interface CreditPurchase {
  transactionId: string;
  userId: string;
  productId: string;
  credits: number;
  createdAt: string;
}

export interface CreditReservation {
  jobId: string;
  userId: string;
  sourceHash: string;
  credits: number;
  quoteVersion: string;
  status: "reserved" | "finalized" | "refunded";
  reservedAt: string;
  settledAt?: string;
}

export interface CreditAccount {
  balance: number;
  purchasedCredits: number;
  reservedCredits: number;
  spentCredits: number;
}

export class CreditLedgerError extends Error {}

export class InsufficientCreditsError extends CreditLedgerError {
  constructor(
    readonly requiredCredits: number,
    readonly balance: number,
  ) {
    super(`Insufficient credits: required ${requiredCredits}, available ${balance}.`);
    this.name = "InsufficientCreditsError";
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function root(config: ServerConfig): string {
  return join(config.entitlementsDir, "credits");
}

function purchasesDir(config: ServerConfig): string {
  return join(root(config), "purchases");
}

function reservationsDir(config: ServerConfig): string {
  return join(root(config), "reservations");
}

function purchasePath(config: ServerConfig, transactionId: string): string {
  return join(purchasesDir(config), `${hash(transactionId)}.json`);
}

function reservationPath(config: ServerConfig, jobId: string): string {
  return join(reservationsDir(config), `${hash(jobId)}.json`);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function rowsIn<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  const rows: T[] = [];
  for (const file of readdirSync(dir)) {
    const row = readJson<T>(join(dir, file));
    if (row) rows.push(row);
  }
  return rows;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const dir = path.slice(0, path.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: "wx" });
  renameSync(temporary, path);
}

export function creditProduct(productId: string): (typeof CREDIT_PRODUCTS)[number] | undefined {
  return CREDIT_PRODUCTS.find((product) => product.productId === productId);
}

export function creditAccount(config: ServerConfig, userId: string): CreditAccount {
  const purchases = rowsIn<CreditPurchase>(purchasesDir(config))
    .filter((row) => row.userId === userId);
  const reservations = rowsIn<CreditReservation>(reservationsDir(config))
    .filter((row) => row.userId === userId);
  const purchasedCredits = purchases.reduce((sum, row) => sum + row.credits, 0);
  const reservedCredits = reservations
    .filter((row) => row.status === "reserved")
    .reduce((sum, row) => sum + row.credits, 0);
  const spentCredits = reservations
    .filter((row) => row.status === "finalized")
    .reduce((sum, row) => sum + row.credits, 0);
  return {
    balance: purchasedCredits - reservedCredits - spentCredits,
    purchasedCredits,
    reservedCredits,
    spentCredits,
  };
}

export function grantCreditPurchase(
  config: ServerConfig,
  input: { userId: string; transactionId: string; productId: string },
): { applied: boolean; purchase: CreditPurchase; account: CreditAccount } {
  const product = creditProduct(input.productId);
  if (!product) throw new CreditLedgerError("Unknown credit product.");
  const path = purchasePath(config, input.transactionId);
  const existing = readJson<CreditPurchase>(path);
  if (existing) {
    if (existing.userId !== input.userId || existing.productId !== input.productId) {
      throw new CreditLedgerError("Transaction is already bound to another purchase.");
    }
    return { applied: false, purchase: existing, account: creditAccount(config, input.userId) };
  }

  const purchase: CreditPurchase = {
    ...input,
    credits: product.credits,
    createdAt: new Date().toISOString(),
  };
  mkdirSync(purchasesDir(config), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(purchase, null, 2), { flag: "wx" });
  } catch (error) {
    const raced = readJson<CreditPurchase>(path);
    if (raced?.userId === input.userId && raced.productId === input.productId) {
      return { applied: false, purchase: raced, account: creditAccount(config, input.userId) };
    }
    throw error;
  }
  return { applied: true, purchase, account: creditAccount(config, input.userId) };
}

export function reserveCredits(
  config: ServerConfig,
  input: Omit<CreditReservation, "status" | "reservedAt" | "settledAt">,
): { applied: boolean; reservation: CreditReservation; account: CreditAccount } {
  const path = reservationPath(config, input.jobId);
  const existing = readJson<CreditReservation>(path);
  if (existing) {
    if (
      existing.userId !== input.userId
      || existing.sourceHash !== input.sourceHash
      || existing.credits !== input.credits
      || existing.quoteVersion !== input.quoteVersion
    ) {
      throw new CreditLedgerError("Job reservation does not match its original quote.");
    }
    if (existing.status !== "refunded") {
      return { applied: false, reservation: existing, account: creditAccount(config, input.userId) };
    }
  }

  const account = creditAccount(config, input.userId);
  if (account.balance < input.credits) {
    throw new InsufficientCreditsError(input.credits, account.balance);
  }
  const reservation: CreditReservation = {
    ...input,
    status: "reserved",
    reservedAt: new Date().toISOString(),
  };
  if (existing) writeJsonAtomic(path, reservation);
  else {
    mkdirSync(reservationsDir(config), { recursive: true });
    writeFileSync(path, JSON.stringify(reservation, null, 2), { flag: "wx" });
  }
  return { applied: true, reservation, account: creditAccount(config, input.userId) };
}

export function settleCreditReservation(
  config: ServerConfig,
  jobId: string,
  status: "finalized" | "refunded",
): CreditReservation | undefined {
  const path = reservationPath(config, jobId);
  const existing = readJson<CreditReservation>(path);
  if (!existing || existing.status === status) return existing;
  if (existing.status !== "reserved") return existing;
  const settled: CreditReservation = {
    ...existing,
    status,
    settledAt: new Date().toISOString(),
  };
  writeJsonAtomic(path, settled);
  return settled;
}

export function creditReservation(
  config: ServerConfig,
  jobId: string,
): CreditReservation | undefined {
  return readJson<CreditReservation>(reservationPath(config, jobId));
}

export function userCreditData(
  config: ServerConfig,
  userId: string,
): { account: CreditAccount; purchases: CreditPurchase[]; reservations: CreditReservation[] } {
  return {
    account: creditAccount(config, userId),
    purchases: rowsIn<CreditPurchase>(purchasesDir(config)).filter((row) => row.userId === userId),
    reservations: rowsIn<CreditReservation>(reservationsDir(config)).filter((row) => row.userId === userId),
  };
}

export function deleteUserCreditData(config: ServerConfig, userId: string): void {
  for (const dir of [purchasesDir(config), reservationsDir(config)]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      const row = readJson<{ userId?: string }>(path);
      if (row?.userId === userId) rmSync(path, { force: true });
    }
  }
}
