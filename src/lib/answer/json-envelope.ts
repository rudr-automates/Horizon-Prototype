/**
 * Helpers for reading a JSON payload out of a chat model's reply.
 *
 * WHY THESE LIVE OUTSIDE A PROVIDER ADAPTER
 *   Two adapters now return the same envelope: a text field containing JSON
 *   that must be unfenced, parsed and then validated against a Zod schema. If
 *   each adapter carried its own copy, a fix to one (a model that wraps its
 *   output in prose, say) would not reach the other, and the two would drift
 *   apart in exactly the situation where nobody is looking — a provider swap.
 */

/**
 * Strip a markdown code fence if the model wrapped its JSON in one.
 *
 * `response_format`/`responseMimeType` do not guarantee a bare object, so a
 * fenced payload is unwrapped before parsing. This weakens NOTHING: the parsed
 * value still has to satisfy the full Zod schema and every downstream check.
 * Without it, fencing would be reported as malformed output and a valid answer
 * would be lost.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Describe WHICH field failed validation, without echoing the model's content.
 * Field paths and issue codes only: enough to act on, nothing that could leak
 * generated text or user material into a log.
 */
export function describeIssues(error: {
  issues: Array<{ path: PropertyKey[]; code: string }>;
}): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`)
    .join(", ");
}

/**
 * Content-free description of what came back, so a malformed response can be
 * told apart from a truncated one without logging the model's text.
 *
 * `tokens` is supplied by the caller because each provider names its counters
 * differently; it carries NUMBERS only.
 */
export function describeJsonShape(
  text: string,
  finishReason: string | undefined,
  tokens: string,
): string {
  const body = text.trim();
  return [
    `length=${text.length}`,
    `startsBrace=${body.startsWith("{")}`,
    `endsBrace=${body.endsWith("}")}`,
    `fenced=${text.includes("```")}`,
    `finishReason=${finishReason ?? "unknown"}`,
    `tokens=${tokens}`,
  ].join(" ");
}
