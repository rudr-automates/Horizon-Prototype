/** Learning actions that intentionally reuse the normal question safety path. */
export const LEARNING_ACTION_PROMPTS = {
  summary:
    "Summarize the main ideas in the lesson evidence eligible at this position. State each supported idea as a concise, separate factual claim and cite its supporting source. Leave out anything the eligible evidence does not support.",
  explainSimply:
    "Explain the current lesson passage in simple language. Keep factual statements supported by evidence eligible at this position, and cite each supported idea. Make clear that this is an explanation, not a direct instructor quote.",
} as const;
