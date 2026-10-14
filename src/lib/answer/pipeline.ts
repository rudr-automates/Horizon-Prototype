import {
  ProviderFailure,
  type GeneratedClaim,
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
  });

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
  let generated;
  try {
    generated = await generator.generate({
      question: input.question,
      evidence: payloadBlocks.map((block) => ({ id: block.id, text: block.text })),
    });
  } catch (error) {
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

  let verdicts;
  try {
    verdicts = await verifier.verify(targets);
  } catch (error) {
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
