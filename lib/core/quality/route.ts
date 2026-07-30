// Effort routing: given the local report and the judge's verdict, decide how much more
// compute a chunk deserves. Bounded so a chunk can never loop forever.

import type { LocalReport } from "./validators";
import type { EstimateChunkOutput } from "../translator";

export type PrecisionMode = "balanced" | "fidelity" | "natural";

export interface RouteDecision {
  action: "accept" | "refine";
  deep: boolean;
  backTranslate: boolean;
}

export const MAX_QUALITY_ITERATIONS = 2;

export function routeDraft(args: {
  local: LocalReport;
  verdict?: EstimateChunkOutput;
  mode: PrecisionMode;
  iteration: number;
}): RouteDecision {
  const accept: RouteDecision = { action: "accept", deep: false, backTranslate: false };
  if (args.iteration >= MAX_QUALITY_ITERATIONS) return accept;

  const { local, verdict, mode } = args;
  const score = verdict?.score;
  const fidelityFlag =
    local.flags.includes("omission") || Boolean(verdict?.omission) || Boolean(verdict?.accuracy);
  const minorFlag = local.flags.includes("glossary") || local.flags.includes("tokens");

  // Hardest: low score or a fidelity problem -> reasoning model (and back-translation in fidelity mode).
  if (fidelityFlag || (score !== undefined && score <= 2)) {
    return { action: "refine", deep: true, backTranslate: mode === "fidelity" };
  }
  // Mid: a 3, or a minor local flag -> a flash refine.
  if (score === 3 || minorFlag) {
    return { action: "refine", deep: false, backTranslate: false };
  }
  // Clean and good (score >= 4 or no verdict and no flags).
  return accept;
}
