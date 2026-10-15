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
 * WHY ADMISSION IS NOW A RESERVATION
 *   Reading the total, deciding, and recording afterwards are three separate
 *   operations. Two concurrent turns could each read the same remaining budget
 *   and both be admitted, so the ceiling was soft by exactly the number of
 *   in-flight calls. Admission is therefore expressed as a RESERVATION that the
 *   ledger must grant atomically: capacity is held before the request is sent
 *   and reconciled afterwards. `reserve` is the only way to be allowed to spend.
 *
 * WHAT IT STILL DOES NOT DO — stated here rather than implied by the name:
 *   - Embedding requests are counted against a durable, concurrency-safe cap,
 *     but their COST is not metered: the embeddings API reports no token usage,
 *     so there is nothing trustworthy to price. The cap bounds requests, not
 *     spending, and calling it a cost cap would be false.
 *   - `estimatedCostUsd` is left NULL. Pricing requires a dated price source;
 *     inventing zero would understate spend, which is worse than saying unknown.
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

/** What the provider reported for one call. `null` means "not reported". */
export interface ReportedUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
}

/** Total tokens a reported usage represents, sanitised. */
export function reportedTotal(usage: ReportedUsage | null): number {
  if (!usage) return 0;
  return count(usage.promptTokens) + count(usage.completionTokens) + count(usage.reasoningTokens);
}

/** A granted reservation. Opaque to callers; the id settles it exactly once. */
export interface GenerationReservation {
  id: string;
  kind: "generation_tokens";
  /** Worst-case tokens held while the call is in flight. */
  reservedTokens: number;
}

export interface GenerationAdmissionRequest {
  /** Worst-case token cost of the call: prompt estimate + output allowance. */
  reserveTokens: number;
  budgetTokens: number;
  provider: string;
  modelId: string | null;
  operation: "generate" | "verify";
}

export interface EmbeddingAdmissionRequest {
  /** Durable ceiling on embedding REQUESTS for the day. */
  maxCalls: number;
  provider: string;
  modelId: string | null;
}

export type ReservationDecision =
  | {
      admitted: true;
      reservation: GenerationReservation;
      spentTokens: number;
      reservedTokens: number;
      detail: string;
    }
  | {
      admitted: false;
      reservation: null;
      spentTokens: number;
      reservedTokens: number;
      detail: string;
    };

export interface EmbeddingAdmissionDecision {
  admitted: boolean;
  usedToday: number;
  detail: string;
}

export interface SettlementResult {
  /** Tokens charged for this call — the figure that counts against the budget. */
  chargedTokens: number;
  /** Tokens the provider actually reported; 0 means it reported nothing. */
  reportedTokens: number;
  /**
   * `reported` — charged at what the provider said.
   * `no_report_charged_reservation` — sent, but nothing was reported, so the
   *   reservation stands rather than collapsing to zero.
   * `failed_no_report_charged_reservation` — same, and the call failed.
   * `failed_not_billable` — the provider REJECTED the request before processing
   *   it, so the hold is released without charge.
   * `already_settled` — a duplicate settle, returned unchanged.
   */
  outcome:
    | "reported"
    | "no_report_charged_reservation"
    | "failed_no_report_charged_reservation"
    | "failed_not_billable"
    | "already_settled"
    | string;
  detail: string;
}

/**
 * The policy that must hold for every ledger implementation.
 *
 * Stated once here because it is the difference between a ceiling and a
 * decoration: a call that was SENT is charged even when the provider reports
 * nothing, because a timeout or a crash is not evidence that nothing was billed.
 */
export const SETTLEMENT_POLICY_NOTE =
  "A granted reservation is reconciled against what the provider reported. When nothing is reported, the reservation itself stands as the charge: a failed or timed-out call may still have been billed, so spend is never erased.";

export interface UsageLedger {
  readonly mode: "supabase" | "memory";
  /**
   * Tokens accounted for the current UTC day, including outstanding
   * reservations. Must THROW rather than return a wrong number: the caller fails
   * closed on error, so a swallowed failure would silently disable the limit.
   */
  spentToday(): Promise<number>;
  /**
   * Atomically reserve generation capacity. Implementations MUST make the
   * check-and-hold indivisible with respect to concurrent callers.
   */
  admitGeneration(request: GenerationAdmissionRequest): Promise<ReservationDecision>;
  /** Atomically count one embedding request against the day's durable cap. */
  admitEmbedding(request: EmbeddingAdmissionRequest): Promise<EmbeddingAdmissionDecision>;
  /**
   * Reconcile a reservation with what the provider reported. Idempotent.
   *
   * `notBillable` means the provider explicitly rejected the request BEFORE
   * processing it (a 429 quota refusal is the live case), so nothing could have
   * been consumed and the hold is released. It must NOT be set for a timeout: an
   * unanswered request may well have been billed, and the reservation then stays
   * as the charge.
   */
  settle(
    reservation: GenerationReservation,
    reported: ReportedUsage | null,
    options?: { failed?: boolean; detail?: string; notBillable?: boolean },
  ): Promise<SettlementResult>;
  /** Append a settled record for a call that never held a reservation. */
  record(entry: UsageEntry): Promise<void>;
}

/** Stable, readable statement of what the recorded number covers. */
export const USAGE_COVERAGE_NOTE =
  "Counts text-generation and verification tokens reported by the provider, " +
  "including billable reasoning tokens. Capacity is reserved atomically in the " +
  "database before each call and reconciled afterwards, and a call that reports " +
  "nothing is charged its reservation rather than erased. Embedding requests are " +
  "counted against a durable cap, but their cost is not metered because that API " +
  "reports no token usage.";

/** UTC day key, so the window is unambiguous regardless of server timezone. */
export function utcDayStart(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** UTC day as a plain `YYYY-MM-DD` date, matching the `day` column. */
export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
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
 * Decide whether a call may proceed, given a total that is already final.
 *
 * This is the pure comparison; it does NOT make the decision atomic. Durable
 * admission goes through `UsageLedger.admitGeneration`, which performs the same
 * comparison inside one database transaction. It remains here because the
 * in-memory ledger needs an equivalent rule and because the rule itself is worth
 * testing in isolation.
 *
 * The rule is a HARD cap: a call is admitted only when the day's recorded spend
 * plus the reservation for this call remains within the budget.
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
