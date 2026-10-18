import { describe, expect, it } from "vitest";
import { answerQuestion, type AnswerPipelineDeps } from "@/lib/answer/pipeline";
import {
  ProviderFailure,
  type ClaimGenerator,
  type Embedder,
  type SemanticVerifier,
} from "@/lib/answer/provider";
import { SyntheticLexicalEmbedder } from "@/lib/answer/synthetic-embedder";
import { DEMO_COURSE, DEMO_QUESTIONS } from "@/lib/demo/lesson";
import { FixtureEvidenceStore } from "@/lib/retrieval/fixture-store";
import type {
  EmbeddingAdmissionDecision,
  GenerationAdmissionRequest,
  GenerationReservation,
  ReportedUsage,
  SettlementResult,
  UsageEntry,
  UsageLedger,
} from "@/lib/usage/types";
import { makeProviders, PERMITTED_BUDGET, TEST_MAX_EMBEDDING_CALLS, TEST_MAX_OUTPUT_TOKENS } from "./helpers/fakes";

/**
 * Every billable path, audited with mocks.
 *
 * The rule this file exists to enforce: a provider call is either preceded by an
 * admission that granted it, or it is not sent at all. Settlement follows every
 * sent call, including failures — a 429 is released as not billable, while a
 * timeout stays charged because the request may already have been processed.
 */

const COURSE = DEMO_COURSE.courseId;

type Event =
  | "admitEmbedding"
  | "embed"
  | "admitGeneration"
  | "generate"
  | "verify"
  | "settle";

interface FakeLedgerOptions {
  admitEmbedding?: boolean;
  admitGeneration?: boolean;
  spend?: number;
}

class RecordingLedger implements UsageLedger {
  readonly mode = "supabase" as const;
  readonly events: Event[] = [];
  readonly settles: Array<{ operation: string; reported: ReportedUsage | null; failed?: boolean; notBillable?: boolean }> = [];
  readonly admissions: GenerationAdmissionRequest[] = [];
  readonly records: UsageEntry[] = [];

  constructor(private readonly options: FakeLedgerOptions = {}) {}

  async spentToday(): Promise<number> {
    return this.options.spend ?? 0;
  }

  async embeddingRequestsToday(): Promise<number> {
    return 0;
  }

  async admitEmbedding(): Promise<EmbeddingAdmissionDecision> {
    this.events.push("admitEmbedding");
    return {
      admitted: this.options.admitEmbedding ?? true,
      usedToday: 1,
      detail: "test decision",
    };
  }

  async admitGeneration(
    request: GenerationAdmissionRequest,
  ): Promise<
    | { admitted: true; reservation: GenerationReservation; spentTokens: number; reservedTokens: number; detail: string }
    | { admitted: false; reservation: null; spentTokens: number; reservedTokens: number; detail: string }
  > {
    this.events.push("admitGeneration");
    this.admissions.push(request);

    if (this.options.admitGeneration === false) {
      return { admitted: false, reservation: null, spentTokens: 0, reservedTokens: 0, detail: "no capacity" };
    }

    return {
      admitted: true,
      reservation: {
        id: `res-${this.admissions.length}`,
        kind: "generation_tokens",
        reservedTokens: request.reserveTokens,
      },
      spentTokens: 0,
      reservedTokens: request.reserveTokens,
      detail: "reserved",
    };
  }

  async settle(
    _reservation: GenerationReservation,
    reported: ReportedUsage | null,
    options?: { failed?: boolean; detail?: string; notBillable?: boolean },
  ): Promise<SettlementResult> {
    this.events.push("settle");
    this.settles.push({
      operation: "call",
      reported,
      failed: options?.failed,
      notBillable: options?.notBillable,
    });
    return { chargedTokens: 10, reportedTokens: 10, outcome: "reported", detail: "settled" };
  }

  async record(entry: UsageEntry): Promise<void> {
    this.records.push(entry);
  }

  async providerCallEvidence() {
    return { state: "none_recorded" as const };
  }
}

function spyingEmbedder(): { embedder: Embedder; calls: () => number } {
  const inner = new SyntheticLexicalEmbedder(768);
  let calls = 0;
  return {
    calls: () => calls,
    embedder: {
      providerId: inner.providerId,
      dimensions: inner.dimensions,
      embed: async (texts) => {
        calls += 1;
        return inner.embed(texts);
      },
    },
  };
}

const ANSWERED_CLAIM = {
  text: "The instructor chooses the Marlin backoff constant, 0.37.",
  evidenceIds: ["b_0013"],
  quote: "Marlin backoff constant, 0.37",
};

function deps(options: {
  ledger: RecordingLedger;
  generator: ClaimGenerator | null;
  verifier: SemanticVerifier | null;
  embed: Embedder;
  budget?: number;
}): AnswerPipelineDeps {
  return {
    store: new FixtureEvidenceStore(new SyntheticLexicalEmbedder(768)),
    providers: makeProviders({
      generator: options.generator,
      verifier: options.verifier,
      embedder: options.embed,
    }),
    modelId: "fake-model",
    embeddingModel: "synthetic-lexical-v1",
    embeddingDimensions: 768,
    dailyTokenBudget: options.budget ?? PERMITTED_BUDGET,
    maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
    maxEmbeddingCalls: TEST_MAX_EMBEDDING_CALLS,
    usage: options.ledger,
  };
}

function ask(depsValue: AnswerPipelineDeps, question: string, boundarySeconds: number) {
  return answerQuestion(depsValue, {
    courseId: COURSE,
    question,
    boundarySeconds,
    scopeMode: "POSITION",
  });
}

describe("metering covers every billable call path", () => {
  it("sends nothing at all when the budget is zero", async () => {
    const ledger = new RecordingLedger();
    const embed = spyingEmbedder();
    let generated = 0;
    let verified = 0;

    const outcome = await ask(
      deps({
        ledger,
        embed: embed.embedder,
        budget: 0,
        generator: {
          providerId: "fake",
          generate: async () => {
            generated += 1;
            return { result: { claims: [ANSWERED_CLAIM], unansweredParts: false }, usage: null };
          },
        },
        verifier: {
          providerId: "fake",
          verify: async (targets) => {
            verified += 1;
            return {
              verdicts: targets.map((target) => ({ index: target.index, verdict: "SUPPORTED" as const, reason: "" })),
              usage: { promptTokens: 1, completionTokens: 1, thoughtsTokens: 0 },
            };
          },
        },
      }),
      DEMO_QUESTIONS.canary,
      720,
    );

    expect(outcome.reason).toBe("BUDGET_EXHAUSTED");
    expect(embed.calls()).toBe(0);
    expect(generated).toBe(0);
    expect(verified).toBe(0);
    expect(ledger.events).toEqual([]);
  });

  it("does not embed when the embedding admission is refused", async () => {
    const ledger = new RecordingLedger({ admitEmbedding: false });
    const embed = spyingEmbedder();

    const outcome = await ask(
      deps({
        ledger,
        embed: embed.embedder,
        generator: { providerId: "fake", generate: async () => ({ result: { claims: [], unansweredParts: true }, usage: null }) },
        verifier: null,
      }),
      DEMO_QUESTIONS.canary,
      720,
    );

    expect(outcome.reason).toBe("BUDGET_EXHAUSTED");
    expect(embed.calls()).toBe(0);
    expect(ledger.events).toEqual(["admitEmbedding"]);
  });

  it("does not generate or verify when the generation admission is refused", async () => {
    const ledger = new RecordingLedger({ admitGeneration: false });
    const embed = spyingEmbedder();
    let generated = 0;
    let verified = 0;

    const outcome = await ask(
      deps({
        ledger,
        embed: embed.embedder,
        generator: {
          providerId: "fake",
          generate: async () => {
            generated += 1;
            return { result: { claims: [ANSWERED_CLAIM], unansweredParts: false }, usage: null };
          },
        },
        verifier: {
          providerId: "fake",
          verify: async (targets) => {
            verified += 1;
            return {
              verdicts: targets.map((target) => ({ index: target.index, verdict: "SUPPORTED" as const, reason: "" })),
              usage: { promptTokens: 1, completionTokens: 1, thoughtsTokens: 0 },
            };
          },
        },
      }),
      DEMO_QUESTIONS.canary,
      720,
    );

    expect(outcome.reason).toBe("BUDGET_EXHAUSTED");
    expect(embed.calls()).toBe(1);
    expect(generated).toBe(0);
    expect(verified).toBe(0);
    // Only the embedding admission happened; no generation capacity was granted.
    expect(ledger.events).toEqual(["admitEmbedding", "admitGeneration"]);
  });

  it("admits before every call and settles after it on the success path", async () => {
    const ledger = new RecordingLedger();
    const embed = spyingEmbedder();
    const events: Event[] = [];
    const originalAdmit = ledger.admitGeneration.bind(ledger);
    ledger.admitGeneration = async (request) => {
      events.push("admitGeneration");
      return originalAdmit(request);
    };
    const originalSettle = ledger.settle.bind(ledger);
    ledger.settle = async (reservation, reported, options) => {
      events.push("settle");
      return originalSettle(reservation, reported, options);
    };
    const originalEmbedAdmit = ledger.admitEmbedding.bind(ledger);
    ledger.admitEmbedding = async (...args) => {
      events.push("admitEmbedding");
      return originalEmbedAdmit(...args);
    };

    const outcome = await ask(
      deps({
        ledger,
        embed: {
          ...embed.embedder,
          embed: async (texts, purpose) => {
            events.push("embed");
            return embed.embedder.embed(texts, purpose);
          },
        },
        generator: {
          providerId: "fake",
          generate: async () => {
            events.push("generate");
            return {
              result: { claims: [ANSWERED_CLAIM], unansweredParts: false },
              usage: { promptTokens: 10, completionTokens: 5, thoughtsTokens: 2 },
            };
          },
        },
        verifier: {
          providerId: "fake",
          verify: async (targets) => {
            events.push("verify");
            return {
              verdicts: targets.map((target) => ({ index: target.index, verdict: "SUPPORTED" as const, reason: "" })),
              usage: { promptTokens: 4, completionTokens: 1, thoughtsTokens: 0 },
            };
          },
        },
      }),
      DEMO_QUESTIONS.canary,
      720,
    );

    expect(outcome.answerState).toBe("ANSWERED");
    // The generation call is settled before verification is reserved, so the
    // verifier's admission sees the tokens the generator actually used.
    expect(events).toEqual([
      "admitEmbedding",
      "embed",
      "admitGeneration",
      "generate",
      "settle",
      "admitGeneration",
      "verify",
      "settle",
    ]);
    expect(ledger.admissions.map((admission) => admission.operation)).toEqual(["generate", "verify"]);
  });

  it("releases a rate-limited call as not billable and never verifies", async () => {
    const ledger = new RecordingLedger();
    const embed = spyingEmbedder();
    let verified = 0;

    const outcome = await ask(
      deps({
        ledger,
        embed: embed.embedder,
        generator: {
          providerId: "fake",
          generate: async () => {
            throw new ProviderFailure("rate_limited", "quota");
          },
        },
        verifier: {
          providerId: "fake",
          verify: async (targets) => {
            verified += 1;
            return {
              verdicts: targets.map((target) => ({ index: target.index, verdict: "SUPPORTED" as const, reason: "" })),
              usage: { promptTokens: 1, completionTokens: 1, thoughtsTokens: 0 },
            };
          },
        },
      }),
      DEMO_QUESTIONS.canary,
      720,
    );

    expect(outcome.reason).toBe("PROVIDER_RATE_LIMITED");
    expect(verified).toBe(0);
    expect(ledger.settles).toHaveLength(1);
    expect(ledger.settles[0].notBillable).toBe(true);
    expect(ledger.settles[0].failed).toBe(true);
  });

  it("keeps the reservation charged when a call times out", async () => {
    const ledger = new RecordingLedger();
    const embed = spyingEmbedder();

    const outcome = await ask(
      deps({
        ledger,
        embed: embed.embedder,
        generator: {
          providerId: "fake",
          generate: async () => {
            throw new ProviderFailure("timeout", "slow");
          },
        },
        verifier: null,
      }),
      DEMO_QUESTIONS.canary,
      720,
    );

    expect(outcome.reason).toBe("PROVIDER_TIMEOUT");
    expect(ledger.settles).toHaveLength(1);
    expect(ledger.settles[0].notBillable).toBe(false);
    expect(ledger.settles[0].failed).toBe(true);
  });
});
