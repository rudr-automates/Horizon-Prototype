import { describe, expect, it } from "vitest";
import { answerQuestion, type AnswerPipelineDeps } from "@/lib/answer/pipeline";
import {
  ProviderFailure,
  type ClaimGenerator,
  type EvidenceItem,
  type SemanticVerifier,
} from "@/lib/answer/provider";
import { makeProviders, PERMITTED_BUDGET } from "./helpers/fakes";
import { SyntheticLexicalEmbedder } from "@/lib/answer/synthetic-embedder";
import { DEMO_COURSE, DEMO_QUESTIONS } from "@/lib/demo/lesson";
import { FixtureEvidenceStore } from "@/lib/retrieval/fixture-store";
import type { EvidenceStore } from "@/lib/retrieval/types";

const COURSE = DEMO_COURSE.courseId;
const embedder = new SyntheticLexicalEmbedder(768);

const supportAll: SemanticVerifier = {
  providerId: "fake-verifier",
  verify: async (targets) =>
    targets.map((target) => ({
      index: target.index,
      verdict: "SUPPORTED" as const,
      reason: "supported by cited evidence",
    })),
};

function scriptedGenerator(
  claims: Array<{ text: string; evidenceIds: string[]; quote: string }>,
  unansweredParts = false,
) {
  const calls: Array<{ question: string; evidence: EvidenceItem[] }> = [];
  const generator: ClaimGenerator = {
    providerId: "fake-generator",
    generate: async (request) => {
      calls.push(request);
      return { claims, unansweredParts };
    },
  };
  return { generator, calls };
}

function makeDeps(
  generator: ClaimGenerator | null,
  verifier: SemanticVerifier | null = supportAll,
  store: EvidenceStore = new FixtureEvidenceStore(embedder),
): AnswerPipelineDeps {
  return {
    store,
    providers: makeProviders({ generator, verifier }),
    modelId: "fake-model",
    embeddingModel: "synthetic-lexical-v1",
    embeddingDimensions: 768,
    dailyTokenBudget: PERMITTED_BUDGET,
  };
}

function ask(deps: AnswerPipelineDeps, question: string, boundarySeconds: number) {
  return answerQuestion(deps, {
    courseId: COURSE,
    question,
    boundarySeconds,
    scopeMode: "POSITION",
  });
}

describe("temporal eligibility through the whole pipeline", () => {
  it("never sends the future-only fact to the model before its unlock time", async () => {
    const { generator, calls } = scriptedGenerator([
      {
        text: "The instructor chooses the Marlin backoff constant, 0.37.",
        evidenceIds: ["b_0013"],
        quote: "Marlin backoff constant, 0.37",
      },
    ]);

    const outcome = await ask(makeDeps(generator), DEMO_QUESTIONS.canary, 360);

    expect(calls).toHaveLength(1);
    const sentIds = calls[0].evidence.map((item) => item.id);
    const sentText = calls[0].evidence.map((item) => item.text).join(" ");

    expect(sentIds).not.toContain("b_0013");
    expect(sentIds).not.toContain("b_0014");
    expect(sentText).not.toContain("0.37");
    expect(sentText).not.toContain("Marlin");
    // Retrieval did return real eligible evidence, so this is a scoping
    // decision and not an accidental empty payload.
    expect(sentIds.length).toBeGreaterThan(0);
    expect(outcome.claims).toHaveLength(0);
    expect(outcome.citations).toHaveLength(0);
  });

  it("refuses when the model cites an id that was not in the eligible payload", async () => {
    const { generator } = scriptedGenerator([
      {
        text: "The instructor chooses the Marlin backoff constant, 0.37.",
        evidenceIds: ["b_0013"],
        quote: "Marlin backoff constant, 0.37",
      },
    ]);

    const outcome = await ask(makeDeps(generator), DEMO_QUESTIONS.canary, 360);

    expect(outcome.answerState).toBe("INSUFFICIENT_EVIDENCE");
    expect(outcome.reason).toBe("UNSUPPORTED_BY_EVIDENCE");
    expect(outcome.claims).toHaveLength(0);
    expect(JSON.stringify(outcome)).not.toContain("0.37");
  });

  it("makes the same fact retrievable and answerable at or after the unlock time", async () => {
    const { generator, calls } = scriptedGenerator([
      {
        text: "The instructor uses the Marlin backoff constant, 0.37.",
        evidenceIds: ["b_0013"],
        quote: "Marlin backoff constant, 0.37",
      },
    ]);

    const outcome = await ask(makeDeps(generator), DEMO_QUESTIONS.canary, 720);

    expect(calls[0].evidence.map((item) => item.id)).toContain("b_0013");
    expect(outcome.answerState).toBe("ANSWERED");
    expect(outcome.claims).toHaveLength(1);
    expect(outcome.citations[0].evidenceId).toBe("b_0013");
    expect(outcome.citations[0].startSeconds).toBe(578);
    expect(outcome.citations[0].sourceLabel).toBe("Transcript 09:38–10:40");
  });

  it("answers from an approved course-wide reference at an early playhead (positive control)", async () => {
    const { generator, calls } = scriptedGenerator([
      {
        text: "Jitter is randomness added to the delay.",
        evidenceIds: ["b_0005"],
        quote: "Jitter: randomness added to that delay to de-synchronise clients",
      },
    ]);

    const outcome = await ask(makeDeps(generator), DEMO_QUESTIONS.courseWideControl, 60);

    expect(calls[0].evidence.map((item) => item.id)).toContain("b_0005");
    expect(calls[0].evidence.map((item) => item.id)).not.toContain("b_0004");
    expect(outcome.answerState).toBe("ANSWERED");
    expect(outcome.citations[0].policy).toBe("COURSE_WIDE");
    expect(outcome.citations[0].sourceLabel).toBe("Course-wide reference (approved)");
  });
});

describe("verification gates", () => {
  it("rejects a quote that does not appear verbatim in the cited block", async () => {
    const { generator } = scriptedGenerator([
      {
        text: "The base factor is seven.",
        evidenceIds: ["b_0003"],
        quote: "the base factor is exactly seven",
      },
    ]);

    const outcome = await ask(makeDeps(generator), "What base factor is used?", 720);

    expect(outcome.answerState).toBe("INSUFFICIENT_EVIDENCE");
    expect(outcome.claims).toHaveLength(0);
  });

  it("does not render a claim the semantic verifier marks NOT_SUPPORTED", async () => {
    const unsupportive: SemanticVerifier = {
      providerId: "fake-verifier",
      verify: async (targets) =>
        targets.map((target) => ({
          index: target.index,
          verdict: "NOT_SUPPORTED" as const,
          reason: "topically related but not supporting",
        })),
    };

    const { generator } = scriptedGenerator([
      {
        text: "Delays multiply by a base factor.",
        evidenceIds: ["b_0003"],
        quote: "multiplies the previous delay by a base factor",
      },
    ]);

    const outcome = await ask(makeDeps(generator, unsupportive), "How does backoff grow?", 720);

    expect(outcome.answerState).toBe("INSUFFICIENT_EVIDENCE");
    expect(outcome.claims).toHaveLength(0);
    expect(outcome.reason).toBe("UNSUPPORTED_BY_EVIDENCE");
  });

  it("returns only the supported claims and marks the answer partial", async () => {
    const partialVerifier: SemanticVerifier = {
      providerId: "fake-verifier",
      verify: async (targets) =>
        targets.map((target) => ({
          index: target.index,
          verdict: target.index === 0 ? ("SUPPORTED" as const) : ("NOT_SUPPORTED" as const),
          reason: "",
        })),
    };

    const { generator } = scriptedGenerator([
      {
        text: "Delays multiply by a base factor.",
        evidenceIds: ["b_0003"],
        quote: "multiplies the previous delay by a base factor",
      },
      {
        text: "The failure distribution matters more than its average.",
        evidenceIds: ["b_0009"],
        quote: "distribution of failures matters more than its average",
      },
    ]);

    const outcome = await ask(
      makeDeps(generator, partialVerifier),
      "Explain backoff delay and the failure distribution.",
      720,
    );

    expect(outcome.answerState).toBe("ANSWERED_PARTIAL");
    expect(outcome.claims).toHaveLength(1);
    expect(outcome.claims[0].citations[0].evidenceId).toBe("b_0003");
  });
});

describe("refusal and failure states", () => {
  it("refuses without rendering anything for a question the corpus cannot support", async () => {
    const { generator } = scriptedGenerator([
      { text: "x", evidenceIds: ["b_0001"], quote: "x" },
    ]);

    const outcome = await ask(
      makeDeps(generator),
      "Explain quantum chromodynamics lattice gauge theory",
      0,
    );

    expect(outcome.answerState).toBe("INSUFFICIENT_EVIDENCE");
    expect(outcome.claims).toHaveLength(0);
    expect(outcome.citations).toHaveLength(0);
    expect(outcome.message).not.toContain("quantum");
  });

  it("refuses with NO_ELIGIBLE_EVIDENCE and never calls the model when retrieval is empty", async () => {
    const real = new FixtureEvidenceStore(embedder);
    const emptyStore: EvidenceStore = {
      mode: real.mode,
      demoContent: real.demoContent,
      getCourse: (id) => real.getCourse(id),
      listCourses: () => real.listCourses(),
      listEligible: (boundary, limit) => real.listEligible(boundary, limit),
      searchFullText: async () => [],
      searchVector: async () => [],
      getBlocksByIds: (boundary, ids) => real.getBlocksByIds(boundary, ids),
      hasMatchingIneligible: async () => false,
    };

    const { generator, calls } = scriptedGenerator([
      { text: "x", evidenceIds: ["b_0001"], quote: "x" },
    ]);

    const outcome = await ask(makeDeps(generator, supportAll, emptyStore), "Anything at all", 0);

    expect(outcome.answerState).toBe("INSUFFICIENT_EVIDENCE");
    expect(outcome.reason).toBe("NO_ELIGIBLE_EVIDENCE");
    expect(outcome.internalState).toBe("NOT_IN_MATERIALS");
    expect(calls).toHaveLength(0);
  });

  it("uses the backend diagnostic to distinguish NOT_AVAILABLE_YET, while returning the SAME public state", async () => {
    const real = new FixtureEvidenceStore(embedder);
    const noHitsStore: EvidenceStore = {
      mode: real.mode,
      demoContent: real.demoContent,
      getCourse: (id) => real.getCourse(id),
      listCourses: () => real.listCourses(),
      listEligible: (boundary, limit) => real.listEligible(boundary, limit),
      searchFullText: async () => [],
      searchVector: async () => [],
      getBlocksByIds: (boundary, ids) => real.getBlocksByIds(boundary, ids),
      hasMatchingIneligible: async () => true,
    };

    const { generator, calls } = scriptedGenerator([]);
    const outcome = await ask(makeDeps(generator, supportAll, noHitsStore), DEMO_QUESTIONS.canary, 360);

    // Internal distinction is retained server-side...
    expect(outcome.internalState).toBe("NOT_AVAILABLE_YET");
    // ...but the learner-facing state and message are identical to NOT_IN_MATERIALS.
    expect(outcome.answerState).toBe("INSUFFICIENT_EVIDENCE");
    expect(outcome.reason).toBe("NO_ELIGIBLE_EVIDENCE");
    expect(calls).toHaveLength(0);
  });

  it("fails safely when no runtime model is configured", async () => {
    const { generator } = scriptedGenerator([]);
    const deps = makeDeps(generator);
    const unconfigured: AnswerPipelineDeps = {
      ...deps,
      providers: makeProviders({ generator: null, verifier: supportAll }),
    };

    const outcome = await ask(unconfigured, DEMO_QUESTIONS.canary, 720);

    expect(outcome.answerState).toBe("TEMPORARILY_UNAVAILABLE");
    expect(outcome.reason).toBe("PROVIDER_UNAVAILABLE");
    expect(outcome.claims).toHaveLength(0);
  });

  it("maps provider rate limits, timeouts and malformed responses to safe states", async () => {
    const cases = [
      ["rate_limited", "PROVIDER_RATE_LIMITED"],
      ["timeout", "PROVIDER_TIMEOUT"],
      ["malformed_response", "PROVIDER_MALFORMED"],
      ["unavailable", "PROVIDER_UNAVAILABLE"],
    ] as const;

    for (const [kind, expectedReason] of cases) {
      const generator: ClaimGenerator = {
        providerId: "fake-generator",
        generate: async () => {
          throw new ProviderFailure(kind, "simulated");
        },
      };
      const outcome = await ask(makeDeps(generator), DEMO_QUESTIONS.canary, 720);
      expect(outcome.answerState).toBe("TEMPORARILY_UNAVAILABLE");
      expect(outcome.reason).toBe(expectedReason);
      expect(outcome.claims).toHaveLength(0);
    }
  });

  it("fails safely when embedding fails", async () => {
    const deps = makeDeps(scriptedGenerator([]).generator);
    const broken: AnswerPipelineDeps = {
      ...deps,
      providers: makeProviders({
        generator: scriptedGenerator([]).generator,
        verifier: supportAll,
        embedder: {
          providerId: "broken-embedder",
          dimensions: 768,
          embed: async () => {
            throw new Error("embedding service unavailable");
          },
        },
      }),
    };

    const outcome = await ask(broken, DEMO_QUESTIONS.canary, 720);
    expect(outcome.answerState).toBe("TEMPORARILY_UNAVAILABLE");
    expect(outcome.reason).toBe("EMBEDDING_UNAVAILABLE");
  });
});

describe("the documented spend guard is real", () => {
  it("makes no provider call at all when the budget permits none", async () => {
    const { generator, calls } = scriptedGenerator([
      {
        text: "The instructor chooses the Marlin backoff constant, 0.37.",
        evidenceIds: ["b_0013"],
        quote: "0.37",
      },
    ]);
    let embedCalls = 0;

    const deps: AnswerPipelineDeps = {
      ...makeDeps(generator),
      dailyTokenBudget: 0,
      providers: makeProviders({
        generator,
        verifier: supportAll,
        embedder: {
          providerId: "counting-embedder",
          dimensions: 768,
          embed: async (texts) => {
            embedCalls += 1;
            return texts.map(() => new Array<number>(768).fill(0.1));
          },
        },
      }),
    };

    const outcome = await ask(deps, DEMO_QUESTIONS.canary, 720);

    expect(outcome.answerState).toBe("TEMPORARILY_UNAVAILABLE");
    expect(outcome.reason).toBe("BUDGET_EXHAUSTED");
    // The embedding call is itself a billable provider call, so the guard must
    // stop it too, not merely the generation call.
    expect(embedCalls).toBe(0);
    expect(calls).toHaveLength(0);
    expect(outcome.claims).toHaveLength(0);
  });

  it("still reports the more informative provider state when nothing is configured", async () => {
    const deps: AnswerPipelineDeps = {
      ...makeDeps(null, null),
      dailyTokenBudget: 0,
    };

    const outcome = await ask(deps, DEMO_QUESTIONS.canary, 720);

    // An unconfigured deployment must not be reported as a budget problem.
    expect(outcome.reason).toBe("PROVIDER_UNAVAILABLE");
  });

  it("does not refuse on budget grounds when the budget permits calls", async () => {
    const deps = makeDeps(scriptedGenerator([]).generator);
    const outcome = await ask(deps, DEMO_QUESTIONS.canary, 720);

    expect(outcome.reason).not.toBe("BUDGET_EXHAUSTED");
  });
});
