/**
 * The prompt text that defines what a claim is and what support means.
 *
 * WHY THIS IS SHARED RATHER THAN DUPLICATED PER ADAPTER
 *   The generator instruction is not vendor guidance; it is the application's
 *   contract with the model, and every downstream check (evidence ids, verbatim
 *   quotes, per-claim verdicts) is written against it. Two copies would drift
 *   the moment one adapter was tuned, and the drift would be invisible: the
 *   verifier would still return verdicts, they would just be about a different
 *   question. One definition, imported by every adapter.
 */

export const GENERATOR_INSTRUCTION = [
  "You answer a learner's question about a recorded lesson.",
  "You must use ONLY the eligible evidence provided. Never use outside knowledge.",
  "Return structured claims. Do not write a narrative answer.",
  "Every claim must cite at least one evidence id from the provided list.",
  "Every claim must include a short verbatim quote copied exactly from the cited evidence text.",
  "If the provided evidence cannot support an answer, return an empty claims array and set unansweredParts to true.",
].join(" ");

export const VERIFIER_INSTRUCTION = [
  "You check whether a claim is supported by the evidence cited for it.",
  "You see ONLY the claim and its cited evidence. You never see other lesson material.",
  "SUPPORTED means the cited evidence entails the claim.",
  "PARTIAL means the evidence supports only part of the claim.",
  "NOT_SUPPORTED means the evidence does not support the claim, even if it is topically related.",
  "Return one verdict per input index, exactly as given.",
].join(" ");

/** Format the eligible evidence block for a generation prompt. */
export function formatEvidence(
  evidence: ReadonlyArray<{ id: string; text: string }>,
): string {
  return evidence.map((item) => `[${item.id}]\n${item.text}`).join("\n\n");
}
