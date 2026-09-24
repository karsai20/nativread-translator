import { isLanguageCode } from "../../lib/core/languages";
import { bookTierForProduct } from "./database";
import { HttpError } from "./security";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const SOURCE_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;

/**
 * What `POST /api/purchase` is paying for. Builds that upload before paying
 * name the job; builds that pay first name the book by its content hash, the
 * language and the product they showed the reader.
 */
export type PurchaseRequest =
  | { kind: "job"; id: string; transactionId: string }
  | {
    kind: "book";
    sourceHash: string;
    targetLanguage: string;
    productId: string;
    transactionId: string;
  };

export function parsePurchaseRequest(body: Record<string, unknown>): PurchaseRequest {
  const { transactionId } = body;
  if (typeof transactionId !== "string" || !TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw new HttpError(400, "Érvénytelen tranzakcióazonosító.");
  }
  if (body.id !== undefined) {
    if (typeof body.id !== "string" || !UUID_PATTERN.test(body.id)) {
      throw new HttpError(400, "Érvénytelen fordításazonosító.");
    }
    return { kind: "job", id: body.id, transactionId };
  }
  const { sourceHash, targetLanguage, productId } = body;
  if (typeof sourceHash !== "string" || !SOURCE_HASH_PATTERN.test(sourceHash)) {
    throw new HttpError(400, "Érvénytelen könyvazonosító.");
  }
  if (!isLanguageCode(targetLanguage)) {
    throw new HttpError(400, "Ismeretlen nyelv.");
  }
  if (typeof productId !== "string" || !bookTierForProduct(productId)) {
    throw new HttpError(400, "Ismeretlen termék.");
  }
  return { kind: "book", sourceHash, targetLanguage, productId, transactionId };
}
