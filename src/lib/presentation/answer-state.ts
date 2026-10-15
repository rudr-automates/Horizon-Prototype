import type { AnswerReason } from "@/lib/contracts/question";
import type { PublicAnswerState } from "@/lib/contracts/domain";

/**
 * Presentation constants for the learner-facing answer states.
 *
 * Kept in a plain module (no React) so the UI and the contract tests can both
 * import it. The test asserts these keys match the public answer-state enum
 * exactly, which is what keeps the interface and the API in agreement.
 */
export type AnswerStateTone = "ok" | "partial" | "refused" | "unavailable";

export const ANSWER_STATE_LABEL = {
  ANSWERED: "Answered",
  ANSWERED_PARTIAL: "Partially answered",
  INSUFFICIENT_EVIDENCE: "Not enough eligible evidence",
  TEMPORARILY_UNAVAILABLE: "Temporarily unavailable",
} satisfies Record<PublicAnswerState, string>;

export const ANSWER_STATE_TONE = {
  ANSWERED: "ok",
  ANSWERED_PARTIAL: "partial",
  INSUFFICIENT_EVIDENCE: "refused",
  TEMPORARILY_UNAVAILABLE: "unavailable",
} satisfies Record<PublicAnswerState, AnswerStateTone>;

export const TONE_CLASSES: Record<AnswerStateTone, string> = {
  ok: "bg-emerald-100 text-emerald-900 border-emerald-300",
  partial: "bg-amber-100 text-amber-900 border-amber-300",
  refused: "bg-slate-200 text-slate-800 border-slate-300",
  unavailable: "bg-rose-100 text-rose-900 border-rose-300",
};

/**
 * Human reading of a refusal/failure reason code.
 *
 * WHY THIS EXISTS
 *   A learner-facing refusal carries a code, and a code is the honest thing to
 *   show an operator but says nothing to a judge. These are TRANSLATIONS of what
 *   the server already reported — no code gains a meaning it does not have, and
 *   `satisfies` makes the map fail to compile if a code is added without a
 *   label, so the interface cannot silently omit one.
 *
 * `PROVIDER_RATE_LIMITED` deliberately names the provider rather than the app:
 * being out of quota and being broken look identical on screen, and confusing
 * them sends someone debugging the wrong system.
 */
export const REASON_LABEL = {
  NONE: "No problem to report",
  NO_ELIGIBLE_EVIDENCE: "No eligible evidence at this position in the lesson",
  UNSUPPORTED_BY_EVIDENCE: "The available material does not support that answer",
  PROVIDER_UNAVAILABLE: "The model provider is unavailable or not configured",
  PROVIDER_RATE_LIMITED: "The model provider refused the request (rate limit or quota)",
  PROVIDER_TIMEOUT: "The model provider timed out",
  PROVIDER_MALFORMED: "The model's structured output did not validate",
  EMBEDDING_UNAVAILABLE: "The question could not be embedded for search",
  BUDGET_EXHAUSTED: "The daily spend guard refused the call",
  INVALID_REQUEST: "The request was invalid",
} satisfies Record<AnswerReason, string>;

export function reasonLabel(reason: string): string {
  return (REASON_LABEL as Record<string, string>)[reason] ?? reason;
}
