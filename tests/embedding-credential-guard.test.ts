import { describe, expect, it } from "vitest";
import { answerQuestion, type AnswerPipelineDeps } from "@/lib/answer/pipeline";
import type { ClaimGenerator, Embedder, SemanticVerifier } from "@/lib/answer/provider";
import type { EvidenceStore } from "@/lib/retrieval/types";
import { DEMO_COURSE } from "@/lib/demo/lesson";
import {
  makeProviders,
  makeUsageLedger,
  PERMITTED_BUDGET,
  TEST_MAX_EMBEDDING_CALLS,
  TEST_MAX_OUTPUT_TOKENS,
} from "./helpers/fakes";

/**
 * The embedder and the store have to agree.
 *
 * A database-backed corpus was embedded with a real embedding model, so its
 * stored vectors live in that model's space. The offline lexical embedder is a
 * different space entirely. Comparing them does not fail — it returns a ranked
 * list of noise, which is worse than an error because every downstream check
 * still passes: eligibility holds, claims are grounded, citations resolve. The
 * only thing wrong is that the evidence was never really retrieved.
 *
 * So the pipeline refuses when the store needs real vectors and there are none.
 * These cases pin down both directions: the refusal, and that the same store
 * proceeds normally once a real embedder exists.
 */

const COURSE = DEMO_COURSE.courseId;
const QUESTION = "What backoff constant does the instructor choose?";

/** A store that reports itself as database-backed and counts every read. */
function countingSupabaseStore(): EvidenceStore & { reads: number } {
  const store: EvidenceStore & { reads: number } = {
    mode: "supabase",
    demoContent: false,
    reads: 0,
    getCourse: async () => {
      store.reads += 1;
      return {
        courseId: COURSE,
        title: "Seeded course",
        durationSeconds: 900,
        demoContent: false,
      };
    },
    listCourses: async () => {
      store.reads += 1;
      return [];
    },
    listEligible: async () => {
      store.reads += 1;
      return [];
    },
    searchFullText: async () => {
      store.reads += 1;
      return [];
    },
    searchVector: async () => {
      store.reads += 1;
      return [];
    },
    getBlocksByIds: async () => {
      store.reads += 1;
      return [];
    },
    hasMatchingIneligible: async () => {
      store.reads += 1;
      return false;
    },
  };
  return store;
}

function countingEmbedder(): Embedder & { calls: number } {
  return {
    calls: 0,
    providerId: "counting-embedder",
    dimensions: 768,
    embed: async function (this: { calls: number }, texts: string[]) {
      this.calls += 1;
      return texts.map(() => new Array<number>(768).fill(0));
    },
  };
}

const generator: ClaimGenerator = {
  providerId: "fake-generator",
  generate: async () => ({ result: { claims: [], unansweredParts: true }, usage: null }),
};

const verifier: SemanticVerifier = {
  providerId: "fake-verifier",
  verify: async (targets) => ({ verdicts: targets.map((t) => ({ index: t.index, verdict: "SUPPORTED" as const, reason: "ok" })), usage: null }),
};

function depsFor(
  store: EvidenceStore,
  embedder: Embedder,
  embeddingConfigured: boolean,
): AnswerPipelineDeps {
  return {
    store,
    providers: makeProviders({ generator, verifier, embedder, embeddingConfigured }),
    modelId: "fake-model",
    embeddingModel: "gemini-embedding-001",
    embeddingDimensions: 768,
    dailyTokenBudget: PERMITTED_BUDGET,
    maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
    maxEmbeddingCalls: TEST_MAX_EMBEDDING_CALLS,
    usage: makeUsageLedger(),
  };
}

function ask(deps: AnswerPipelineDeps) {
  return answerQuestion(deps, {
    courseId: COURSE,
    question: QUESTION,
    boundarySeconds: 720,
    scopeMode: "POSITION",
  });
}

describe("a database-backed corpus needs a real embedder", () => {
  it("refuses instead of searching stored vectors with a foreign vector", async () => {
    const store = countingSupabaseStore();
    const embedder = countingEmbedder();

    const outcome = await ask(depsFor(store, embedder, false));

    expect(outcome.answerState).toBe("TEMPORARILY_UNAVAILABLE");
    expect(outcome.reason).toBe("EMBEDDING_UNAVAILABLE");
    // Nothing was sent and nothing was read: not the model, not the database.
    // Spending an embedding request to discover this would be a wasted call.
    expect(embedder.calls).toBe(0);
    expect(store.reads).toBe(0);
    expect(outcome.guard.detail).toMatch(/embedding credential/);
  });

  it("proceeds with the same store once a real embedding credential exists", async () => {
    // The guard keys on the flag, not on the store mode alone: this must not
    // become a blanket refusal of the database path.
    const store = countingSupabaseStore();
    const embedder = countingEmbedder();

    const outcome = await ask(depsFor(store, embedder, true));

    expect(outcome.reason).not.toBe("EMBEDDING_UNAVAILABLE");
    expect(embedder.calls).toBe(1);
    // The store was consulted; with no matching rows the outcome is the ordinary
    // insufficient-evidence refusal.
    expect(store.reads).toBeGreaterThan(0);
    expect(outcome.answerState).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("still allows the labelled sample fixture to use the offline embedder", async () => {
    // The fixture embeds BOTH sides with the same stand-in, so it is
    // self-consistent. Refusing it would remove the only path that works with
    // no credentials at all.
    const { FixtureEvidenceStore } = await import("@/lib/retrieval/fixture-store");
    const { SyntheticLexicalEmbedder } = await import("@/lib/answer/synthetic-embedder");
    const embedder = new SyntheticLexicalEmbedder(768);

    const outcome = await ask(
      depsFor(new FixtureEvidenceStore(embedder), embedder, false),
    );

    expect(outcome.reason).not.toBe("EMBEDDING_UNAVAILABLE");
  });
});
