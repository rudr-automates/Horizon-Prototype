import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AssistantPanel } from "@/components/lesson/assistant-panel";
import { LEARNING_ACTION_PROMPTS } from "@/lib/learning/actions";

describe("evidence-gated learner actions", () => {
  it("offers summary and simple explanation through the standard cited-answer path", () => {
    const html = renderToStaticMarkup(createElement(AssistantPanel, {
      question: "",
      onQuestionChange: () => undefined,
      onAsk: vi.fn(),
      pending: false,
      result: null,
      requestError: null,
      suggestions: [],
      playhead: 300,
      askedAt: null,
      canSeekCitation: false,
      onPlayCitation: () => undefined,
      onShowInTranscript: () => undefined,
      aiConfigured: true,
      embeddingConfigured: true,
    }));

    expect(html).toContain("Summarize so far");
    expect(html).toContain("Explain simply");
    expect(LEARNING_ACTION_PROMPTS.summary).toContain("eligible");
    expect(LEARNING_ACTION_PROMPTS.summary).toContain("cite its supporting source");
    expect(LEARNING_ACTION_PROMPTS.explainSimply).toContain("not a direct instructor quote");
  });
});
