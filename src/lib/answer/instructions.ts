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
  // A learner reads the claims as the answer, and a bare keyword is not one.
  // Observed live: a question about which topics a lesson covers came back as
  // fourteen one-word claims (\"Embeddings\", \"RAG\", \"Claude\"), which is a list
  // label rather than a statement anything can be verified against.
  "Each claim must be a complete sentence that states one point and stands on its own as an answer; never return a bare keyword.",
  "Return at most five claims. Merge related points into one claim instead of splitting a list into one claim per item.",
  "Every claim must cite at least one evidence id from the provided list.",
  // The transcript is machine transcription, so it repeats words and has no
  // reliable punctuation. A model that tidies the quotation fails Tier-1, which
  // checks the span against the stored text — so the instruction says what will
  // be checked rather than asking for readable prose.
  "Every claim must include a short verbatim quote copied exactly from the cited evidence text: the same words in the same order, with nothing added, reordered or corrected, even where the transcription is imperfect.",
  "If the provided evidence cannot support an answer, return an empty claims array and set unansweredParts to true.",
  "If it supports only part of the question, answer that part and set unansweredParts to true.",
].join(" ");

export const VERIFIER_INSTRUCTION = [
  "You check whether a claim is supported by the evidence cited for it.",
  "You see ONLY the claim and its cited evidence. You never see other lesson material.",
  // The earlier wording (\"the cited evidence entails the claim\") let a verifier
  // reject a claim that simply restated an item from a list in the evidence,
  // which is the shape most answers about a lesson take. The verdict has to be
  // about what the evidence SAYS, not about whether the claim adds anything.
  "SUPPORTED means the cited evidence states the claim, or states the fact the claim restates; a claim that names or summarises an item appearing in a list in the evidence is supported by that list.",
  "PARTIAL means the evidence supports only part of the claim.",
  "NOT_SUPPORTED means the evidence contradicts the claim or never mentions it. Being on the same topic is not support.",
  "Return one verdict per input index, exactly as given.",
].join(" ");

/** Format the eligible evidence block for a generation prompt. */
export function formatEvidence(
  evidence: ReadonlyArray<{ id: string; text: string }>,
): string {
  return evidence.map((item) => `[${item.id}]\n${item.text}`).join("\n\n");
}
