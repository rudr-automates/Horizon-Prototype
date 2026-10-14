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
