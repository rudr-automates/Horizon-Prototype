import type { GeneratedClaim } from "@/lib/answer/provider";

/**
 * Tier-1 deterministic claim checks (blueprint §9.6).
 *
 * These are pure, model-free checks that must pass before any claim can be
 * displayed. Tier-2 (semantic support) requires a model call and is NOT
 * implemented in Part 01.
 */

/** Normalize whitespace and case for tolerant quote matching. */
export function normalizeForQuoteMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export interface DeterministicCheckContext {
  /** Evidence IDs that were actually sent in the model payload. */
  payloadEvidenceIds: ReadonlySet<string>;
  /** Normalized text for each cited block, keyed by block id. */
  blockTextById: ReadonlyMap<string, string>;
}

export interface DeterministicCheckResult {
  ok: boolean;
  reasons: string[];
}

export function checkClaimDeterministically(
  claim: GeneratedClaim,
  context: DeterministicCheckContext,
): DeterministicCheckResult {
  const reasons: string[] = [];

  if (claim.evidenceIds.length === 0) {
    reasons.push("claim cites no evidence");
  }

  for (const id of claim.evidenceIds) {
    if (!context.payloadEvidenceIds.has(id)) {
      reasons.push(`evidence id not in payload: ${id}`);
    }
  }

  const quote = normalizeForQuoteMatch(claim.quote);
  if (quote === "") {
    reasons.push("claim quote is empty");
  } else {
    const appears = claim.evidenceIds.some((id) => {
      const blockText = context.blockTextById.get(id);
      return blockText
        ? normalizeForQuoteMatch(blockText).includes(quote)
        : false;
    });
    if (!appears) {
      reasons.push("quoted span not found in any cited block");
    }
  }

  return { ok: reasons.length === 0, reasons };
}
