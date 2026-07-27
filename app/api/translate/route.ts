import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { hashSource } from "@/lib/core/library";
import { loadConfig } from "@/lib/server/config";
import { getState, jobDirFor, ownsJob, startJob, isValidJobId } from "@/lib/server/jobs";
import { hasTranslationEntitlement } from "@/lib/server/entitlements";
import { requestContext } from "@/lib/server/request-context";
import type { PrecisionMode } from "@/lib/core/quality/route";
import {
  CreditLedgerError,
  InsufficientCreditsError,
  reserveCredits,
  settleCreditReservation,
} from "@/lib/server/credits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TERMS_VERSION = "2026-07-20";

function providerDisclosureName(provider: string): string {
  switch (provider) {
    case "gemini": return "Google Gemini API";
    case "openai": return "OpenAI API";
    case "deepseek": return "DeepSeek API";
    default: return "NativRead test provider";
  }
}

function consentVersion(provider: string): string {
  return `2026-07-20-${provider}`;
}

export async function POST(req: Request): Promise<Response> {
  const config = loadConfig();
  const ctx = await requestContext(req, config);
  if (ctx instanceof Response) return ctx;

  const {
    id,
    sample,
    precision,
    rightsAttested,
    termsAccepted,
    termsVersion,
    aiProcessingConsent,
    aiConsentVersion,
    aiProvider,
  } = (await req.json().catch(() => ({}))) as {
    id?: string;
    sample?: boolean;
    precision?: PrecisionMode;
    rightsAttested?: boolean;
    termsAccepted?: boolean;
    termsVersion?: string;
    aiProcessingConsent?: boolean;
    aiConsentVersion?: string;
    aiProvider?: string;
  };
  if (!id || !isValidJobId(id)) return Response.json({ error: "Hiányzik vagy érvénytelen a job azonosító." }, { status: 400 });
  if (precision && precision !== "balanced" && precision !== "fidelity" && precision !== "natural") {
    return Response.json({ error: "Érvénytelen minőségi mód." }, { status: 400 });
  }
  // Production/mobile mode is activated by a configured OIDC audience. In
  // that mode the service processes a book only after the user explicitly
  // confirms a lawful basis for this translation. This is a product/legal
  // gate, not a substitute for an actual licence when one is required.
  if (config.appleClientIds?.length || config.googleClientIds?.length) {
    if (
      rightsAttested !== true
      || termsAccepted !== true
      || termsVersion !== TERMS_VERSION
    ) {
      return Response.json(
        { error: "A fordítás előtt fogadd el az aktuális felhasználási feltételeket." },
        { status: 403 },
      );
    }
    if (
      aiProcessingConsent !== true
      || aiConsentVersion !== consentVersion(config.providerName)
      || aiProvider !== providerDisclosureName(config.providerName)
    ) {
      return Response.json(
        { error: "Az AI-feldolgozáshoz új, szolgáltatóspecifikus engedély szükséges." },
        { status: 403 },
      );
    }
  }

  const jobDir = jobDirFor(config, id);
  const sourcePath = join(jobDir, "source.epub");
  if (!existsSync(sourcePath)) {
    return Response.json({ error: "Ismeretlen job." }, { status: 404 });
  }

  // Own job only, fail-closed like every other job route: a manifest with no
  // recorded owner belongs to nobody, so it can never be started by anyone.
  // Unknown and not-owned both 404 so existence never leaks.
  const manifest = getState(config, id);
  if (!ownsJob(manifest, ctx.userId)) {
    return Response.json({ error: "Ismeretlen job." }, { status: 404 });
  }

  if (!sample && config.requireFullTranslationEntitlements) {
    const sourceHash = manifest?.sourceHash ?? hashSource(new Uint8Array(readFileSync(sourcePath)));
    // The pipeline is Hungarian-only today; when jobs carry a target
    // language, check the job's language here instead.
    if (!hasTranslationEntitlement(config, ctx.userId, sourceHash, "hu")) {
      if (
        manifest?.requiredCredits === undefined
        || manifest.requiredCredits < 0
        || !manifest.quoteVersion
      ) {
        return Response.json(
          { error: "This upload has no valid character quote. Upload the book again." },
          { status: 409 },
        );
      }
      try {
        if (manifest.requiredCredits > 0) {
          reserveCredits(config, {
            jobId: id,
            userId: ctx.userId,
            sourceHash,
            credits: manifest.requiredCredits,
            quoteVersion: manifest.quoteVersion,
          });
        }
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return Response.json(
            {
              error: "Insufficient translation credits.",
              requiredCredits: error.requiredCredits,
              balance: error.balance,
            },
            { status: 402 },
          );
        }
        if (error instanceof CreditLedgerError) {
          return Response.json({ error: error.message }, { status: 409 });
        }
        throw error;
      }
    }
  }

  try {
    startJob(config, id, { sample: Boolean(sample), ...(precision ? { precision } : {}) });
  } catch (error) {
    if (!sample) settleCreditReservation(config, id, "refunded");
    throw error;
  }
  return Response.json({ ok: true });
}
