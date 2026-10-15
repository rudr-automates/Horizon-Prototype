import {
  meteredTokens,
  ProviderFailure,
  type GeneratedClaim,
  type ClaimGenerationResult,
  type TokenUsage,
  type VerificationTarget,
} from "@/lib/answer/provider";
import type { RuntimeProviders } from "@/lib/answer/providers";
import {
  checkClaimDeterministically,
  normalizeForQuoteMatch,
} from "@/lib/answer/verification";
import {
  toPublicAnswerState,
  type InternalAnswerState,
  type PublicAnswerState,
} from "@/lib/contracts/domain";
import type {
  AnswerReason,
  Citation,
  EvidenceSource,
  ScopeSummary,
  VerifiedClaim,
} from "@/lib/contracts/question";
import { isBlockEligible } from "@/lib/eligibility/predicate";
import { fuseRanked } from "@/lib/retrieval/fusion";
import {
  count,
  decideAdmission,
  estimatePromptTokens,
  USAGE_COVERAGE_NOTE,
  type UsageLedger,
} from "@/lib/usage/types";
import { formatSeconds } from "@/lib/retrieval/source-label";
import type {
  EvidenceBlock,
  EvidenceBoundary,
  EvidenceStore,
  RankedHit,
} from "@/lib/retrieval/types";

/** Candidates requested from each retrieval branch before fusion. */
export const CANDIDATES_PER_BRANCH = 20;
/** Final fused evidence sent to the model. */
export const FINAL_TOP_K = 6;
/** Cap on eligible blocks counted for the scope chip. */
const SCOPE_COUNT_LIMIT = 1000;

export const REFUSAL_MESSAGE =
  "I can't support that answer with the material available for this response.";
export const PARTIAL_NOTE =
  "Part of that question could not be supported by the material available for this response.";
export const UNAVAILABLE_MESSAGE =
  "The assistant is temporarily unavailable, so no answer was generated.";

export interface AnswerPipelineInput {
  courseId: string;
  question: string;
  boundarySeconds: number;
  scopeMode: "POSITION" | "PROGRESS";
}

export interface AnswerPipelineDeps {
  store: EvidenceStore;
  providers: RuntimeProviders;
  modelId: string | null;
  embeddingModel: string;
  embeddingDimensions: number;
  /**
   * Cumulative daily token ceiling. Enforced at admission, before every billable
   * request, against what the ledger has actually recorded. `<= 0` still means
   * "no provider call at all". Only meaningful when a credential exists; an
   * unconfigured deployment reports PROVIDER_UNAVAILABLE, which is more useful.
   */
  dailyTokenBudget: number;
  /** Worst-case completion size, used to reserve before a call is sent. */
  maxOutputTokens: number;
  /** Where the cumulative total comes from. */
  usage: UsageLedger;
}

export interface AnswerOutcome {
  answerState: PublicAnswerState;
  /** SERVER-SIDE ONLY. Never serialize this into a learner-facing response. */
  internalState: InternalAnswerState;
  reason: AnswerReason;
  message: string;
  claims: VerifiedClaim[];
  citations: Citation[];
  scope: ScopeSummary;
  evidence: {
    source: EvidenceSource;
    retrievedCount: number;
    payloadCount: number;
    embeddingProvider: string;
    generator: string | null;
    verifier: string | null;
  };
  provenance: {
    modelId: string | null;
    embeddingModel: string;
    embeddingDimensions: number;
    verification: "none" | "model_assisted";
    demoContent: boolean;
  };
  /**
   * The spend state actually in effect for this turn. Reported so nobody has to
   * infer a cap from a budget value that may not be backing anything.
   */
  guard: {
    mode: "supabase" | "memory";
    budgetTokens: number;
    spentTokensToday: number;
    /** What the recorded number does and does not cover. */
    coverage: string;
    detail: string;
  };
}

/**
 * Server-side diagnostics for a provider failure.
 *
 * The learner only ever sees a coarse reason code, which is correct. That left
 * a real gap: distinguishing "the generator returned off-schema JSON" from "the
 * verifier did" was impossible, so a live failure could not be acted on. The
 * stage and the validated error message are logged server-side only. The
 * message reports which field failed validation, never the model's content.
 */
function noteProviderFailure(stage: string, error: unknown): void {
  if (error instanceof ProviderFailure) {
    console.error(`[horizon] provider failure at ${stage}: ${error.kind} — ${error.message}`);
  } else {
    console.error(`[horizon] provider failure at ${stage}: unexpected error type`);
  }
}

function failureReason(failure: ProviderFailure): AnswerReason {
  switch (failure.kind) {
    case "not_configured":
      return "PROVIDER_UNAVAILABLE";
    case "rate_limited":
      return "PROVIDER_RATE_LIMITED";
    case "timeout":
      return "PROVIDER_TIMEOUT";
    case "malformed_response":
      return "PROVIDER_MALFORMED";
    case "unavailable":
      return "PROVIDER_UNAVAILABLE";
  }
}

export async function answerQuestion(
  deps: AnswerPipelineDeps,
  input: AnswerPipelineInput,
): Promise<AnswerOutcome> {
  const boundary: EvidenceBoundary = {
    courseId: input.courseId,
    boundarySeconds: input.boundarySeconds,
  };

  const baseScope: ScopeSummary = {
    boundarySeconds: input.boundarySeconds,
    scopeMode: input.scopeMode,
    eligibleBlockCount: 0,
    policySummary: `Lesson through ${formatSeconds(input.boundarySeconds)} · approved course-wide references enabled`,
  };

  const baseProvenance = {
    modelId: deps.modelId,
    embeddingModel: deps.embeddingModel,
    embeddingDimensions: deps.embeddingDimensions,
    verification: (deps.providers.verifier ? "model_assisted" : "none") as
      | "none"
      | "model_assisted",
    demoContent: deps.store.demoContent,
  };

  const evidenceBase = {
    source: deps.store.mode as EvidenceSource,
    retrievedCount: 0,
    payloadCount: 0,
    embeddingProvider: deps.providers.embeddingProviderId,
    generator: deps.providers.generator?.providerId ?? null,
    verifier: deps.providers.verifier?.providerId ?? null,
  };

  // ---------------------------------------------------------------------
  // 0. Spend guard — cumulative, and enforced at admission.
  //
  //    The ledger total is read ONCE per turn; everything recorded during the
  //    turn accumulates in `turnTokens`, so admission stays accurate without a
  //    query per call. A call is sent only when the day's recorded spend plus a
  //    reservation for this call still fits the budget, which is what makes the
  //    ceiling hard rather than advisory.
  // ---------------------------------------------------------------------
  const usageLedger = deps.usage;
  let recordedToday = 0;
  let ledgerReadable = true;
  try {
    recordedToday = await usageLedger.spentToday();
  } catch {
    ledgerReadable = false;
  }

  let turnTokens = 0;

  const guardState: AnswerOutcome["guard"] = {
    mode: usageLedger.mode,
    budgetTokens: deps.dailyTokenBudget,
    spentTokensToday: 0,
    coverage: USAGE_COVERAGE_NOTE,
    detail: "",
  };

  const refreshGuard = (detail: string): void => {
    guardState.spentTokensToday = recordedToday + turnTokens;
    guardState.detail = detail;
  };

  refreshGuard(
    deps.providers.configured
      ? usageLedger.mode === "memory"
        ? `Daily budget ${deps.dailyTokenBudget} tokens, counted in memory for this process only (it resets on restart).`
        : `Daily budget ${deps.dailyTokenBudget} tokens, counted durably in the database.`
      : "No runtime credential is configured, so no provider request is sent and nothing is metered.",
  );

  /**
   * Decide whether a billable request may be sent. Fails CLOSED: if the ledger
   * cannot be read then spend is unknown, and an unknown spend must not be
   * treated as zero spend.
   */
  const admit = (promptText: string): boolean => {
    if (!deps.providers.configured) return true;

    if (!ledgerReadable) {
      refreshGuard(
        "The usage ledger could not be read, so the day's spend is unknown and the provider call was refused.",
      );
      return false;
    }

    const decision = decideAdmission(
      recordedToday + turnTokens,
      deps.dailyTokenBudget,
      estimatePromptTokens(promptText) + deps.maxOutputTokens,
    );

    if (!decision.admitted) {
      refreshGuard(decision.detail);
      return false;
    }
    return true;
  };

  /**
   * Record what the provider actually reported. A missing report is recorded as
   * nothing rather than as zero, so the ledger never claims to know more than
   * the provider told it.
   */
  const meter = async (
    providerId: string,
    operation: "generate" | "verify",
    reported: TokenUsage | null,
  ): Promise<void> => {
    if (!reported) return;

    const promptTokens = count(reported.promptTokens);
    const completionTokens = count(reported.completionTokens);
    const reasoningTokens = count(reported.thoughtsTokens);
    // Prompt + completion + reasoning: all three are billed, so all three count.
    turnTokens += meteredTokens(reported);

    try {
      await usageLedger.record({
        provider: providerId,
        modelId: deps.modelId,
        requestId: null,
        turnId: null,
        promptTokens,
        completionTokens,
        reasoningTokens,
        operation,
      });
    } catch {
      // The call already happened, so the spend is real either way. Keep it in
      // the turn total and let the next turn re-read the ledger, which will
      // fail closed if the ledger is still unwritable.
    }
  };

  const unavailable = (reason: AnswerReason): AnswerOutcome => ({
    answerState: "TEMPORARILY_UNAVAILABLE",
    internalState: "TEMPORARILY_UNAVAILABLE",
    reason,
    message: UNAVAILABLE_MESSAGE,
    claims: [],
    citations: [],
    scope: baseScope,
    evidence: evidenceBase,
    provenance: baseProvenance,
    guard: { ...guardState },
  });

  const refuse = (internal: InternalAnswerState, reason: AnswerReason): AnswerOutcome => ({
    answerState: toPublicAnswerState(internal),
    internalState: internal,
    reason,
    message: REFUSAL_MESSAGE,
    claims: [],
    citations: [],
    scope: baseScope,
    evidence: evidenceBase,
    provenance: baseProvenance,
    guard: { ...guardState },
  });

  // The embedding request is itself billable, so the guard runs before it.
  if (!admit(input.question)) {
    return unavailable("BUDGET_EXHAUSTED");
  }

  // 1. Embed the question.
  let questionEmbedding: number[];
  try {
    const vectors = await deps.providers.embedder.embed([input.question], "query");
    const first = vectors[0];
    if (!first || first.length !== deps.providers.embedder.dimensions) {
      return unavailable("EMBEDDING_UNAVAILABLE");
    }
    questionEmbedding = first;
  } catch (error) {
    noteProviderFailure("embed", error);
    return unavailable(error instanceof ProviderFailure ? failureReason(error) : "EMBEDDING_UNAVAILABLE");
  }

  // 2. Both retrieval branches, each filtering with the canonical predicate.
  let ftsHits: RankedHit[] = [];
  let vectorHits: RankedHit[] = [];
  try {
    [ftsHits, vectorHits] = await Promise.all([
      deps.store.searchFullText(boundary, input.question, CANDIDATES_PER_BRANCH),
      deps.store.searchVector(boundary, questionEmbedding, CANDIDATES_PER_BRANCH),
    ]);
  } catch {
    return unavailable("PROVIDER_UNAVAILABLE");
  }

  // 3. Rank fusion with deterministic ordering.
  const fused = fuseRanked(ftsHits, vectorHits, FINAL_TOP_K);
  evidenceBase.retrievedCount = fused.length;

  // 4. Scope chip counts (currently eligible only).
  try {
    const eligible = await deps.store.listEligible(boundary, SCOPE_COUNT_LIMIT);
    baseScope.eligibleBlockCount = eligible.length;
  } catch {
    baseScope.eligibleBlockCount = 0;
  }

  // 5. No eligible candidates at all.
  if (fused.length === 0) {
    let hasIneligible = false;
    try {
      hasIneligible = await deps.store.hasMatchingIneligible(boundary, input.question);
    } catch {
      hasIneligible = false;
    }
    // Both outcomes map to the SAME learner-facing state and message.
    return refuse(
      hasIneligible ? "NOT_AVAILABLE_YET" : "NOT_IN_MATERIALS",
      "NO_ELIGIBLE_EVIDENCE",
    );
  }

  // 6. Final payload guard: re-fetch and re-assert eligibility.
  const payloadIds = fused.map((entry) => entry.block.id);
  let payloadBlocks: EvidenceBlock[];
  try {
    payloadBlocks = await deps.store.getBlocksByIds(boundary, payloadIds);
  } catch {
    return unavailable("PROVIDER_UNAVAILABLE");
  }

  const guardPassed =
    payloadBlocks.length === payloadIds.length &&
    payloadBlocks.every((block) =>
      isBlockEligible(
        {
          courseId: block.courseId,
          ingestStatus: block.ingestStatus,
          policy: block.policy,
          reviewState: block.reviewState,
          lintStatus: block.lintStatus,
          unlockSeconds: block.unlockSeconds,
        },
        { courseId: boundary.courseId, boundarySeconds: boundary.boundarySeconds },
      ),
    );

  if (!guardPassed) {
    // A release-gate violation: refuse rather than send anything questionable.
    return refuse("NOT_IN_MATERIALS", "NO_ELIGIBLE_EVIDENCE");
  }

  evidenceBase.payloadCount = payloadBlocks.length;

  // 7. No verified generator means no inference is possible.
  const generator = deps.providers.generator;
  if (!generator) {
    return unavailable("PROVIDER_UNAVAILABLE");
  }

  // 8. Generate structured claims from eligible evidence only.
  const generationPrompt = [
    input.question,
    ...payloadBlocks.map((block) => block.text),
  ].join("\n");

  if (!admit(generationPrompt)) {
    return unavailable("BUDGET_EXHAUSTED");
  }

  let generated: ClaimGenerationResult;
  try {
    const outcome = await generator.generate({
      question: input.question,
      evidence: payloadBlocks.map((block) => ({ id: block.id, text: block.text })),
    });
    generated = outcome.result;
    await meter(generator.providerId, "generate", outcome.usage);
  } catch (error) {
    noteProviderFailure("generate", error);
    // A failed call is still billed, so meter whatever the provider reported.
    if (error instanceof ProviderFailure) {
      await meter(generator.providerId, "generate", error.usage);
    }
    return unavailable(error instanceof ProviderFailure ? failureReason(error) : "PROVIDER_UNAVAILABLE");
  }

  // 9. Tier 1 deterministic checks.
  const payloadIdSet = new Set(payloadIds);
  const blockTextById = new Map(payloadBlocks.map((block) => [block.id, block.text]));

  const tier1Survivors: GeneratedClaim[] = [];
  for (const claim of generated.claims) {
    const result = checkClaimDeterministically(claim, {
      payloadEvidenceIds: payloadIdSet,
      blockTextById,
    });
    if (result.ok) tier1Survivors.push(claim);
  }

  if (tier1Survivors.length === 0) {
    return refuse("NOT_IN_MATERIALS", "UNSUPPORTED_BY_EVIDENCE");
  }

  // 10. Tier 2 model-assisted semantic support verification.
  const verifier = deps.providers.verifier;
  if (!verifier) {
    return unavailable("PROVIDER_UNAVAILABLE");
  }

  const targets: VerificationTarget[] = tier1Survivors.map((claim, index) => ({
    index,
    claimText: claim.text,
    evidence: claim.evidenceIds.map((id) => ({
      id,
      text: blockTextById.get(id) ?? "",
    })),
  }));

  const verificationPrompt = targets
    .map((target) => `${target.claimText}\n${target.evidence.map((item) => item.text).join("\n")}`)
    .join("\n");

  if (!admit(verificationPrompt)) {
    return unavailable("BUDGET_EXHAUSTED");
  }

  let verdicts;
  try {
    const outcome = await verifier.verify(targets);
    verdicts = outcome.verdicts;
    await meter(verifier.providerId, "verify", outcome.usage);
  } catch (error) {
    noteProviderFailure("verify", error);
    if (error instanceof ProviderFailure) {
      await meter(verifier.providerId, "verify", error.usage);
    }
    return unavailable(error instanceof ProviderFailure ? failureReason(error) : "PROVIDER_UNAVAILABLE");
  }

  const supportedIndexes = new Set(
    verdicts.filter((verdict) => verdict.verdict === "SUPPORTED").map((verdict) => verdict.index),
  );

  // 11. Render verified claims only, with server-resolved citations.
  const claims: VerifiedClaim[] = [];
  const citations: Citation[] = [];
  for (const [index, claim] of tier1Survivors.entries()) {
    if (!supportedIndexes.has(index)) continue;

    const claimCitations = buildCitations(claim, payloadBlocks);
    if (claimCitations.length === 0) continue;

    claims.push({ text: claim.text, citations: claimCitations });
    citations.push(...claimCitations);
  }

  if (claims.length === 0) {
    return refuse("NOT_IN_MATERIALS", "UNSUPPORTED_BY_EVIDENCE");
  }

  const droppedAny = claims.length < generated.claims.length;
  const partial = droppedAny || generated.unansweredParts;

  const internal: InternalAnswerState = partial ? "ANSWERED_PARTIAL" : "ANSWERED";

  refreshGuard(
    `${turnTokens} token(s) reported for this turn; ${recordedToday + turnTokens} of ${deps.dailyTokenBudget} used today.`,
  );

  return {
    answerState: toPublicAnswerState(internal),
    internalState: internal,
    reason: "NONE",
    message: partial ? PARTIAL_NOTE : "",
    claims,
    citations,
    scope: baseScope,
    evidence: evidenceBase,
    provenance: baseProvenance,
    guard: { ...guardState },
  };
}

/**
 * Build citations server-side from real block locations. The claim quote is
 * attached only to blocks where it actually appears, so a citation always
 * points at text that genuinely contains the quoted span.
 */
function buildCitations(claim: GeneratedClaim, payloadBlocks: EvidenceBlock[]): Citation[] {
  const normalizedQuote = normalizeForQuoteMatch(claim.quote);
  const byId = new Map(payloadBlocks.map((block) => [block.id, block]));

  const citations: Citation[] = [];
  for (const id of claim.evidenceIds) {
    const block = byId.get(id);
    if (!block) continue;
    if (!normalizeForQuoteMatch(block.text).includes(normalizedQuote)) continue;

    citations.push({
      evidenceId: block.id,
      sourceLabel: block.sourceLabel,
      blockType: block.blockType,
      startSeconds: block.startSeconds,
      endSeconds: block.endSeconds,
      pageNumber: block.pageNumber,
      slideNumber: block.slideNumber,
      lineStart: block.lineStart,
      lineEnd: block.lineEnd,
      policy: block.policy,
      quote: claim.quote,
    });
  }
  return citations;
}
