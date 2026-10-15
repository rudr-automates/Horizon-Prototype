import { describe, expect, it } from "vitest";
import {
  answerQuestion,
  CANDIDATES_PER_BRANCH,
  FINAL_TOP_K,
  type AnswerPipelineDeps,
} from "@/lib/answer/pipeline";
import type { ClaimGenerator, SemanticVerifier } from "@/lib/answer/provider";
import { SyntheticLexicalEmbedder } from "@/lib/answer/synthetic-embedder";
import { DEMO_COURSE, DEMO_QUESTIONS } from "@/lib/demo/lesson";
import { fuseRanked } from "@/lib/retrieval/fusion";
import { FixtureEvidenceStore } from "@/lib/retrieval/fixture-store";
import { estimatePromptTokens } from "@/lib/usage/types";
import { makeProviders, makeUsageLedger, TEST_MAX_EMBEDDING_CALLS } from "./helpers/fakes";

/**
 * CONCURRENCY, AND WHAT THESE TESTS ACTUALLY PROVE
 *
 * The defect being guarded: budget admission used to be read → decide → record as
 * three separate operations, so turns in flight at the same time could all read
 * the same remaining budget and all be admitted. The day could overshoot by as
 * many calls as were concurrent.
 *
 * These tests drive REAL pipeline turns over a SHARED ledger and assert the
 * invariants that must hold no matter how they interleave:
 *
 *   - exactly one turn is answered;
 *   - a refused turn reaches the provider ZERO times;
 *   - the day's total never exceeds the budget.
 *
 * The budget is derived from the pipeline's OWN reservation arithmetic rather
 * than hard-coded, so the test cannot drift away from the code it is testing.
 *
 * What this cannot prove is that POSTGRES serializes admission — only a live
 * database can show that. `scripts/verify-budget-concurrency.ts` does exactly
 * that against the real functions; its output is recorded in docs/evidence.
 */

const COURSE = DEMO_COURSE.courseId;
const embedder = new SyntheticLexicalEmbedder(768);
const QUESTION = DEMO_QUESTIONS.canary;
const BOUNDARY = 720;

/**
 * Large output allowance so the reservation arithmetic has margins that do not
 * depend on the exact length of the fixture's blocks.
 */
const MAX_OUTPUT_TOKENS = 10_000;

const supportAll: SemanticVerifier = {
  providerId: "fake-verifier",
  verify: async (targets) => ({
    verdicts: targets.map((target) => ({
      index: target.index,
      verdict: "SUPPORTED" as const,
      reason: "supported",
    })),
    // Tiny but NON-ZERO: a call that reports nothing is charged its whole
    // reservation, which would change what this test is measuring.
    usage: { promptTokens: 1, completionTokens: 1, thoughtsTokens: 0 },
  }),
};

const ANSWERING_CLAIM = {
  text: "The instructor chooses the Marlin backoff constant, 0.37.",
  evidenceIds: ["b_0013"],
  quote: "0.37",
};

/**
 * The exact token reservation the pipeline will make for a generation call,
 * computed by replaying its own retrieval and prompt assembly steps.
 */
async function generationReserveFor(question: string, boundarySeconds: number): Promise<number> {
  const store = new FixtureEvidenceStore(embedder);
  const boundary = { courseId: COURSE, boundarySeconds };
  // The offline lexical embedder declares no `purpose` parameter, and it
  // ignores it in any case.
  const vector = (await embedder.embed([question]))[0];

  const [ftsHits, vectorHits] = await Promise.all([
    store.searchFullText(boundary, question, CANDIDATES_PER_BRANCH),
    store.searchVector(boundary, vector, CANDIDATES_PER_BRANCH),
  ]);

  const fused = fuseRanked(ftsHits, vectorHits, FINAL_TOP_K);
  const blocks = await store.getBlocksByIds(
    boundary,
    fused.map((entry) => entry.block.id),
  );
  const prompt = [question, ...blocks.map((block) => block.text)].join("\n");

  return estimatePromptTokens(prompt) + MAX_OUTPUT_TOKENS;
}

function makeDeps(
  generator: ClaimGenerator,
  ledger: AnswerPipelineDeps["usage"],
  budget: number,
): AnswerPipelineDeps {
  return {
    store: new FixtureEvidenceStore(embedder),
    providers: makeProviders({ generator, verifier: supportAll }),
    modelId: "fake-model",
    embeddingModel: "synthetic-lexical-v1",
    embeddingDimensions: 768,
    dailyTokenBudget: budget,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxEmbeddingCalls: TEST_MAX_EMBEDDING_CALLS,
    usage: ledger,
  };
}

function ask(deps: AnswerPipelineDeps) {
  return answerQuestion(deps, {
    courseId: COURSE,
    question: QUESTION,
    boundarySeconds: BOUNDARY,
    scopeMode: "POSITION",
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for the first turn to hold its reservation");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("two simultaneous turns cannot over-reserve the budget", () => {
  it("answers only one turn when the budget covers a single reservation", async () => {
    const budget = await generationReserveFor(QUESTION, BOUNDARY);
    const ledger = makeUsageLedger();
    const gate = deferred();
    let generateCalls = 0;

    const generator: ClaimGenerator = {
      providerId: "gated-generator",
      generate: async () => {
        generateCalls += 1;
        // Hold the first turn INSIDE its reservation window, so the second turn
        // makes its own admission while that capacity is still held. The timeout
        // keeps a genuine failure from hanging the suite.
        await Promise.race([gate.promise, new Promise((resolve) => setTimeout(resolve, 1500))]);
        return {
          result: { claims: [ANSWERING_CLAIM], unansweredParts: false },
          usage: { promptTokens: 50, completionTokens: 50, thoughtsTokens: 0 },
        };
      },
    };

    const deps = makeDeps(generator, ledger, budget);

    const first = ask(deps);
    await waitUntil(() => generateCalls === 1);

    // The first turn now holds its reservation and is parked inside generate.
    const secondOutcome = await ask(deps);
    expect(secondOutcome.reason).toBe("BUDGET_EXHAUSTED");
    // The refused turn must not have reached the provider at all.
    expect(generateCalls).toBe(1);

    gate.resolve();
    const firstOutcome = await first;

    expect(firstOutcome.answerState).toBe("ANSWERED");
    expect(await ledger.spentToday()).toBeLessThanOrEqual(budget);
  });

  it("answers exactly one of several turns started at the same time", async () => {
    const budget = await generationReserveFor(QUESTION, BOUNDARY);
    const ledger = makeUsageLedger();
    let generateCalls = 0;

    const generator: ClaimGenerator = {
      providerId: "counting-generator",
      generate: async () => {
        generateCalls += 1;
        return {
          result: { claims: [ANSWERING_CLAIM], unansweredParts: false },
          usage: { promptTokens: 50, completionTokens: 50, thoughtsTokens: 0 },
        };
      },
    };

    const deps = makeDeps(generator, ledger, budget);
    const outcomes = await Promise.all([ask(deps), ask(deps), ask(deps), ask(deps)]);

    const refused = outcomes.filter((outcome) => outcome.reason === "BUDGET_EXHAUSTED");
    const answered = outcomes.filter((outcome) => outcome.answerState === "ANSWERED");

    // A budget of exactly one reservation can only ever produce one answer, no
    // matter how the four turns interleave — including the case where the
    // admitted turn settles before the others try to reserve.
    expect(answered).toHaveLength(1);
    expect(refused).toHaveLength(3);
    expect(generateCalls).toBe(1);
    expect(await ledger.spentToday()).toBeLessThanOrEqual(budget);
  });

  it("does not let a second turn reuse capacity held by an unfinished call", async () => {
    // Straight at the ledger, with exact arithmetic: a 600-token hold against a
    // 1000-token budget leaves 400, so a second 600-token reservation cannot fit.
    // Under the previous design nothing was held until after the call, so BOTH
    // would have been granted against the same remaining budget.
    const ledger = makeUsageLedger();
    const request = {
      reserveTokens: 600,
      budgetTokens: 1000,
      provider: "google-genai",
      modelId: "gemini-3.6-flash",
      operation: "generate" as const,
    };

    const decisions = await Promise.all([
      ledger.admitGeneration(request),
      ledger.admitGeneration(request),
    ]);

    expect(decisions.filter((decision) => decision.admitted)).toHaveLength(1);
    expect(decisions.filter((decision) => decision.reservation === null)).toHaveLength(1);
    expect(await ledger.spentToday()).toBe(600);
  });

  it("holds capacity a later call cannot spend, even before settlement", async () => {
    const ledger = makeUsageLedger();
    await ledger.admitGeneration({
      reserveTokens: 900,
      budgetTokens: 1000,
      provider: "google-genai",
      modelId: null,
      operation: "generate",
    });

    const second = await ledger.admitGeneration({
      reserveTokens: 200,
      budgetTokens: 1000,
      provider: "google-genai",
      modelId: null,
      operation: "verify",
    });

    // 900 held + 200 needed > 1000, so the second call is refused even though
    // nothing has been settled yet.
    expect(second.admitted).toBe(false);
    expect(second.detail).toMatch(/100 remain/);
  });
});
