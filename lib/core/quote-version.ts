/**
 * The identity of the counting rules, kept in a leaf module with no imports.
 *
 * Both the Worker and the iOS app need these two numbers without pulling in
 * `metering.ts` — which drags `node-html-parser` and the chunker along, and has
 * no business inside a Worker bundle. `metering.ts` re-exports them, so there is
 * still exactly one place they are written down.
 */

/** Characters that buy one credit. */
export const CHARACTERS_PER_CREDIT = 1_000;

/**
 * Bumped whenever the counting rules change. The iOS app ships a port of the
 * counter and compares its own version against this one: a mismatch means the
 * port is stale, and the app must fall back to a server quote instead of
 * showing a price it can no longer be sure of.
 */
export const QUOTE_VERSION = "source-chars-v1";
