import { NextResponse } from "next/server";
import { answerQuestion } from "@/lib/answer/pipeline";
import {
  questionRequestSchema,
  questionResponseSchema,
  type QuestionResponse,
} from "@/lib/contracts/question";
import { errorResponse, newRequestId } from "@/lib/http/api";
import {
  createTurnRecorder,
  toTurnRecord,
  type PersistenceOutcome,
} from "@/lib/persistence/turns";
import { readServerEnv } from "@/lib/env";
import { createServerContext } from "@/lib/server/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/v1/courses/:courseId/questions
 *
 * The full path: resolve scope → eligible-only retrieval (both branches) →
 * rank fusion → payload eligibility guard → claims-only generation →
 * Tier-1 deterministic checks → Tier-2 model-assisted support verification →
 * verified-claims render, or a safe refusal.
 *
 * Provider problems return HTTP 200 with answerState TEMPORARILY_UNAVAILABLE,
 * because that is a domain state (the learner must see it), not a transport
 * error. The internal answer state is deliberately NOT serialized.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> },
): Promise<NextResponse> {
  const requestId = newRequestId();
  const { courseId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_REQUEST", "The request body must be JSON.", requestId);
  }

  const parsed = questionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      "INVALID_REQUEST",
      "The question request was invalid. Send a question of 3–500 characters and a playheadSeconds value.",
      requestId,
    );
  }

  const startedAt = Date.now();

  try {
    const { config, providers, storeResolution } = createServerContext();
    const store = storeResolution.store;

    const course = await store.getCourse(courseId);
    if (!course) {
      return errorResponse("NOT_FOUND", "That course was not found.", requestId);
    }

    const boundarySeconds = Math.min(
      parsed.data.playheadSeconds,
      course.durationSeconds,
    );

    const outcome = await answerQuestion(
      {
        store,
        providers,
        modelId: providers.modelId,
        embeddingModel: config.embeddingModel,
        embeddingDimensions: config.embeddingDimensions,
        dailyTokenBudget: config.dailyTokenBudget,
      },
      {
        courseId,
        question: parsed.data.question,
        boundarySeconds,
        scopeMode: parsed.data.scopeMode,
      },
    );

    // Persistence is best-effort and must never break the learner's answer.
    // A failure is reported as `persisted: false`, not retried into latency.
    const latencyMs = Math.max(0, Date.now() - startedAt);
    let persistence: PersistenceOutcome;
    try {
      const recorder = createTurnRecorder(readServerEnv());
      persistence = await recorder.record(
        toTurnRecord(
          outcome,
          {
            courseId,
            question: parsed.data.question,
            boundarySeconds,
            scopeMode: parsed.data.scopeMode,
          },
          latencyMs,
        ),
      );
    } catch {
      persistence = {
        persisted: false,
        mode: "disabled",
        detail: "The turn record could not be written.",
      };
    }

    // Build the response explicitly so no server-side-only field can leak.
    const response: QuestionResponse = {
      requestId,
      answerState: outcome.answerState,
      reason: outcome.reason,
      message: outcome.message,
      latencyMs,
      persistence: {
        persisted: persistence.persisted,
        mode: persistence.mode,
        detail: persistence.detail,
      },
      claims: outcome.claims,
      citations: outcome.citations,
      scope: outcome.scope,
      evidence: outcome.evidence,
      provenance: outcome.provenance,
    };

    return NextResponse.json(questionResponseSchema.parse(response));
  } catch {
    return errorResponse(
      "INTERNAL_ERROR",
      "The question could not be processed.",
      requestId,
    );
  }
}
