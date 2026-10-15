/**
 * Usage accounting for the spend guard.
 *
 * WHY THIS EXISTS
 *   `HORIZON_DAILY_TOKEN_BUDGET` was previously consulted only as "is it
 *   greater than zero". A positive value therefore permitted unlimited calls:
 *   the name promised a daily ceiling that nothing enforced. This module makes
 *   the ceiling cumulative by recording what the provider actually reports and
 *   admitting a call only when the day's total can still absorb it.
 *
 * WHAT IT DOES NOT DO — stated here rather than implied by the name:
 *   - Embedding requests are NOT metered. The Gemini embeddings endpoint does
 *     not return token usage, so there is nothing trustworthy to record. A
 *     positive budget therefore does NOT bound embedding cost.
 *   - `estimatedCostUsd` is left NULL. Pricing requires a dated price source;
 *     inventing zero would understate spend, which is worse than saying unknown.
 *   - Reservation is not atomic. Two concurrent turns can both be admitted
 *     against the same remaining budget. Making that atomic needs a
 *     server-side aggregate/lock, which is a follow-up migration.
 */

export interface UsageEntry {
  provider: string;
  modelId: string | null;
  requestId: string | null;
  turnId: string | null;
  /** Tokens reported by the provider for the prompt. */
  promptTokens: number;
  /** Tokens reported by the provider for the completion. */
  completionTokens: number;
  /**
   * Billable reasoning tokens (`thoughtsTokenCount`), reported SEPARATELY from
   * `completionTokens` by the provider. They are carried as their own field
   * because a total that silently drops them under-counts real spend by orders
   * of magnitude — observed live at 984 reasoning against 21 visible tokens.
   */
  reasoningTokens: number;
  /** What the call was for, so the ledger is readable. */
  operation: "generate" | "verify";
}

/**
 * What one entry contributes to the day's spend. Both ledgers MUST persist this
 * same sum, or the enforced cap and the recorded total diverge and the limit
 * becomes softer than the reported number suggests.
 */
export function entryTotalTokens(entry: UsageEntry): number {
  return count(entry.promptTokens) + count(entry.completionTokens) + count(entry.reasoningTokens);
}

/**
 * A single component of a usage figure. Negative, NaN and non-finite values
 * contribute nothing: they must never act as a credit against the daily cap.
 */
export function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export interface UsageLedger {
  readonly mode: "supabase" | "memory";
  /**
   * Tokens accounted for the current UTC day. Must THROW rather than return a
   * wrong number: the caller fails closed on error, so a swallowed failure
   * would silently disable the limit.
   */
  spentToday(): Promise<number>;
  /** Append a record. Must throw on failure for the same reason. */
  record(entry: UsageEntry): Promise<void>;
}

/** Stable, readable statement of what the recorded number covers. */
export const USAGE_COVERAGE_NOTE =
  "Counts text-generation and verification tokens reported by the provider, " +
  "including billable reasoning tokens. Embedding requests are not metered " +
  "because that API reports no token usage.";

/** UTC day key, so the window is unambiguous regardless of server timezone. */
export function utcDayStart(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/**
 * Cheap, deliberately CONSERVATIVE prompt-size estimate, used only to decide
 * admission before a call. It is an approximation, not a tokenizer: it is
 * documented as such and it is never recorded as fact.
 */
export function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface AdmissionDecision {
  admitted: boolean;
  spentToday: number;
  budget: number;
  /** Tokens held back to cover this call's worst case. */
  reserved: number;
  detail: string;
}

/**
 * Decide whether a call may proceed. The rule is a HARD cap: a call is admitted
 * only when the day's recorded spend plus the reservation for this call remains
 * within the budget. Because every call is reserved before it is sent, no call
 * can push the day past the budget — there is no "one turn of overshoot".
 */
export function decideAdmission(
  spentToday: number,
  budget: number,
  reserved: number,
): AdmissionDecision {
  if (budget <= 0) {
    return {
      admitted: false,
      spentToday,
      budget,
      reserved,
      detail: "The spend guard permits no provider call at all.",
    };
  }

  const remaining = budget - spentToday;
  if (reserved > remaining) {
    return {
      admitted: false,
      spentToday,
      budget,
      reserved,
      detail: `This call needs about ${reserved} tokens but only ${remaining} remain of the daily budget.`,
    };
  }

  return {
    admitted: true,
    spentToday,
    budget,
    reserved,
    detail: `${spentToday} of ${budget} tokens used today; reserving ${reserved}.`,
  };
}
