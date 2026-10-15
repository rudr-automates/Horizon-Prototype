import { describe, expect, it } from "vitest";
import { answerQuestion, type AnswerOutcome } from "@/lib/answer/pipeline";
import type { ClaimGenerator, SemanticVerifier } from "@/lib/answer/provider";
import { SyntheticLexicalEmbedder } from "@/lib/answer/synthetic-embedder";
import {
  internalAnswerStateSchema,
  publicAnswerStateSchema,
  toPublicAnswerState,
} from "@/lib/contracts/domain";
import { questionRequestSchema, questionResponseSchema } from "@/lib/contracts/question";
import { DEMO_COURSE } from "@/lib/demo/lesson";
import { ANSWER_STATE_LABEL, ANSWER_STATE_TONE } from "@/lib/presentation/answer-state";
import { FixtureEvidenceStore } from "@/lib/retrieval/fixture-store";
import { makeProviders, PERMITTED_BUDGET } from "./helpers/fakes";

const COURSE = DEMO_COURSE.courseId;

const supportAll: SemanticVerifier = {
  providerId: "fake-verifier",
  verify: async (targets) =>
    targets.map((target) => ({ index: target.index, verdict: "SUPPORTED" as const, reason: "" })),
};

/** Serialize exactly the way the API route does, from a real pipeline outcome. */
function toResponseBody(outcome: AnswerOutcome) {
  return {
    requestId: "req_test",
    answerState: outcome.answerState,
    reason: outcome.reason,
    message: outcome.message,
    latencyMs: 12,
    persistence: {
      persisted: false,
      mode: "disabled" as const,
      detail: "No database is configured, so this turn was not stored.",
    },
    claims: outcome.claims,
    citations: outcome.citations,
    scope: outcome.scope,
    evidence: outcome.evidence,
    provenance: outcome.provenance,
  };
}

async function outcomeFrom(generator: ClaimGenerator): Promise<AnswerOutcome> {
  return answerQuestion(
    {
      store: new FixtureEvidenceStore(new SyntheticLexicalEmbedder(768)),
      providers: makeProviders({ generator, verifier: supportAll }),
      modelId: "fake-model",
      embeddingModel: "synthetic-lexical-v1",
      embeddingDimensions: 768,
      dailyTokenBudget: PERMITTED_BUDGET,
    },
    {
      courseId: COURSE,
      question: "What backoff constant does the instructor choose, and why?",
      boundarySeconds: 720,
      scopeMode: "POSITION",
    },
  );
}

describe("UI and API agree on answer states", () => {
  it("labels every public answer state and nothing else", () => {
    expect(Object.keys(ANSWER_STATE_LABEL).sort()).toEqual(
      [...publicAnswerStateSchema.options].sort(),
    );
    expect(Object.keys(ANSWER_STATE_TONE).sort()).toEqual(
      [...publicAnswerStateSchema.options].sort(),
    );
  });

  it("collapses both insufficient-evidence subtypes into one identical public state", () => {
    expect(toPublicAnswerState("NOT_AVAILABLE_YET")).toBe("INSUFFICIENT_EVIDENCE");
    expect(toPublicAnswerState("NOT_IN_MATERIALS")).toBe("INSUFFICIENT_EVIDENCE");
    expect(publicAnswerStateSchema.options).not.toContain("NOT_AVAILABLE_YET");
    expect(publicAnswerStateSchema.options).not.toContain("NOT_IN_MATERIALS");
  });

  it("defines every internal state", () => {
    expect(internalAnswerStateSchema.options).toEqual([
      "ANSWERED",
      "ANSWERED_PARTIAL",
      "NOT_AVAILABLE_YET",
      "NOT_IN_MATERIALS",
      "TEMPORARILY_UNAVAILABLE",
    ]);
  });
});

describe("request contract", () => {
  it("accepts a well-formed question and defaults the scope mode", () => {
    const parsed = questionRequestSchema.safeParse({
      question: "What is jitter?",
      playheadSeconds: 60,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.scopeMode).toBe("POSITION");
  });

  it("rejects a too-short question, a missing playhead and an unknown scope mode", () => {
    expect(questionRequestSchema.safeParse({ question: "hi", playheadSeconds: 0 }).success).toBe(false);
    expect(questionRequestSchema.safeParse({ question: "What is jitter?" }).success).toBe(false);
    expect(
      questionRequestSchema.safeParse({
        question: "What is jitter?",
        playheadSeconds: 0,
        scopeMode: "EVERYTHING",
      }).success,
    ).toBe(false);
  });
});

describe("response contract", () => {
  it("matches the schema for an answered turn and resolves citations", async () => {
    const generator: ClaimGenerator = {
      providerId: "fake-generator",
      generate: async () => ({
        claims: [
          {
            text: "The instructor uses the Marlin backoff constant, 0.37.",
            evidenceIds: ["b_0013"],
            quote: "Marlin backoff constant, 0.37",
          },
        ],
        unansweredParts: false,
      }),
    };

    const body = toResponseBody(await outcomeFrom(generator));
    const parsed = questionResponseSchema.parse(body);

    expect(parsed.answerState).toBe("ANSWERED");
    expect(parsed.claims[0].citations[0].evidenceId).toBe("b_0013");
    expect(parsed.claims[0].citations[0].startSeconds).toBe(578);
    expect(parsed.citations[0].sourceLabel).toBe("Transcript 09:38–10:40");
  });

  it("matches the schema for a refusal and carries no leaked internals", async () => {
    const generator: ClaimGenerator = {
      providerId: "fake-generator",
      generate: async () => ({
        claims: [
          {
            text: "The instructor uses the Marlin backoff constant, 0.37.",
            evidenceIds: ["b_0013"],
            quote: "Marlin backoff constant, 0.37",
          },
        ],
        unansweredParts: false,
      }),
    };

    const outcome = await answerQuestion(
      {
        store: new FixtureEvidenceStore(new SyntheticLexicalEmbedder(768)),
        providers: makeProviders({ generator, verifier: supportAll }),
        modelId: "fake-model",
        embeddingModel: "synthetic-lexical-v1",
        embeddingDimensions: 768,
        dailyTokenBudget: PERMITTED_BUDGET,
      },
      {
        courseId: COURSE,
        question: "What backoff constant does the instructor choose, and why?",
        boundarySeconds: 360, // the fact has not unlocked yet
        scopeMode: "POSITION",
      },
    );

    const raw = JSON.stringify(toResponseBody(outcome));
    const parsed = questionResponseSchema.parse(JSON.parse(raw));

    expect(parsed.answerState).toBe("INSUFFICIENT_EVIDENCE");
    expect(parsed.claims).toHaveLength(0);
    // The internal distinction must never reach the browser.
    expect(raw).not.toContain("internalState");
    expect(raw).not.toContain("NOT_AVAILABLE_YET");
    expect(raw).not.toContain("NOT_IN_MATERIALS");
    expect(raw).not.toContain("0.37");
    expect(raw).not.toContain("Marlin");
  });

  it("serializes a provider failure as a domain state the UI can render", async () => {
    const outcome = await answerQuestion(
      {
        store: new FixtureEvidenceStore(new SyntheticLexicalEmbedder(768)),
        providers: makeProviders({ generator: null, verifier: supportAll }),
        modelId: null,
        embeddingModel: "synthetic-lexical-v1",
        embeddingDimensions: 768,
        dailyTokenBudget: PERMITTED_BUDGET,
      },
      {
        courseId: COURSE,
        question: "What backoff constant does the instructor choose, and why?",
        boundarySeconds: 720,
        scopeMode: "POSITION",
      },
    );

    const parsed = questionResponseSchema.parse(toResponseBody(outcome));
    expect(parsed.answerState).toBe("TEMPORARILY_UNAVAILABLE");
    expect(parsed.reason).toBe("PROVIDER_UNAVAILABLE");
    expect(parsed.provenance.modelId).toBeNull();
    expect(parsed.provenance.verification).toBe("model_assisted");
  });
});
