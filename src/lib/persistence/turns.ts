import type { SupabaseClient } from "@supabase/supabase-js";
import type { InternalAnswerState } from "@/lib/contracts/domain";
import type { AnswerReason, Citation, ScopeMode } from "@/lib/contracts/question";
import { createServiceRoleClient, isDatabaseConfigured } from "@/lib/db/server";
import type { ServerEnv } from "@/lib/env";

/**
 * Minimal turn persistence (blueprint §9.8).
 *
 * A turn records what the system was asked, what scope it was asked in, which
 * evidence actually reached the model, which claims survived verification and
 * which INTERNAL answer state resulted. That is the minimum needed to make a
 * question/answer pair reproducible and its citations inspectable later.
 *
 * Two rules matter here:
 *   1. Persistence is never allowed to break a learner's answer. A failure is
 *      recorded as "not persisted", never swallowed silently and never retried
 *      into the user's latency budget.
 *   2. The INTERNAL answer state is stored (the database keeps the distinction
 *      between NOT_AVAILABLE_YET and NOT_IN_MATERIALS); the learner-facing
 *      response does not expose it.
 */

export interface TurnRecord {
  courseId: string;
  question: string;
  boundarySeconds: number;
  scopeMode: ScopeMode;
  evidenceIds: string[];
  citations: Citation[];
  internalAnswerState: InternalAnswerState;
  reason: AnswerReason;
  modelId: string | null;
  embeddingModel: string;
  verification: "none" | "model_assisted";
  evidenceSource: "supabase" | "fixture";
  latencyMs: number;
}

export interface PersistenceOutcome {
  /** True ONLY when a row was actually written. */
  persisted: boolean;
  mode: "supabase" | "disabled";
  /** Plain-language explanation shown to the operator, never a raw provider error. */
  detail: string;
}

export interface TurnRecorder {
  readonly mode: "supabase" | "disabled";
  record(turn: TurnRecord): Promise<PersistenceOutcome>;
}

/**
 * Used when no database is configured. It reports `persisted: false` rather
 * than pretending the turn was stored.
 */
export class DisabledTurnRecorder implements TurnRecorder {
  readonly mode = "disabled" as const;

  async record(turn: TurnRecord): Promise<PersistenceOutcome> {
    // The turn is intentionally unused; refusing to write it is the whole point.
    void turn;
    return {
      persisted: false,
      mode: "disabled",
      detail: "No database is configured, so this turn was not stored.",
    };
  }
}

export class SupabaseTurnRecorder implements TurnRecorder {
  readonly mode = "supabase" as const;

  constructor(private readonly client: SupabaseClient) {}

  async record(turn: TurnRecord): Promise<PersistenceOutcome> {
    try {
      // A fixture-backed turn has no course row, so writing it would either
      // fail a foreign key or invent a course. Report the truth instead.
      if (turn.evidenceSource === "fixture") {
        return {
          persisted: false,
          mode: "supabase",
          detail:
            "This turn used the labelled sample fixture corpus, which has no course row, so nothing was stored.",
        };
      }

      const conversationId = await this.ensureConversation(turn);
      if (!conversationId) {
        return {
          persisted: false,
          mode: "supabase",
          detail: "The conversation could not be created, so this turn was not stored.",
        };
      }

      const sequence = await this.nextSequence(conversationId);
      if (sequence === null) {
        return {
          persisted: false,
          mode: "supabase",
          detail: "The turn sequence could not be resolved, so this turn was not stored.",
        };
      }

      const { error } = await this.client.from("turns").insert({
        conversation_id: conversationId,
        sequence,
        question: turn.question,
        scope_mode: turn.scopeMode,
        boundary_seconds: turn.boundarySeconds,
        evidence_ids: turn.evidenceIds,
        verified_claims: turn.citations,
        answer_state: turn.internalAnswerState,
        reason_code: turn.reason,
        model_id: turn.modelId,
        latency_ms: Math.max(0, Math.round(turn.latencyMs)),
      });

      if (error) {
        return {
          persisted: false,
          mode: "supabase",
          detail: "The turn could not be written.",
        };
      }

      return { persisted: true, mode: "supabase", detail: "Turn stored." };
    } catch {
      return {
        persisted: false,
        mode: "supabase",
        detail: "The turn could not be written.",
      };
    }
  }

  private async ensureConversation(turn: TurnRecord): Promise<string | null> {
    const existing = await this.client
      .from("conversations")
      .select("id")
      .eq("course_id", turn.courseId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (existing.error) return null;
    const rows = (existing.data ?? []) as Array<{ id: string }>;
    if (rows.length > 0) return rows[0].id;

    const created = await this.client
      .from("conversations")
      .insert({ course_id: turn.courseId, scope_mode: turn.scopeMode })
      .select("id")
      .maybeSingle();

    if (created.error) return null;
    return (created.data as { id: string } | null)?.id ?? null;
  }

  private async nextSequence(conversationId: string): Promise<number | null> {
    const { data, error } = await this.client
      .from("turns")
      .select("sequence")
      .eq("conversation_id", conversationId)
      .order("sequence", { ascending: false })
      .limit(1);

    if (error) return null;
    const rows = (data ?? []) as Array<{ sequence: number }>;
    return rows.length === 0 ? 0 : rows[0].sequence + 1;
  }
}

/**
 * Resolve the recorder for this process. When persistence is unavailable the
 * caller still gets a recorder, so the route needs no special-casing — but it
 * will always report `persisted: false`.
 */
export function createTurnRecorder(env: ServerEnv): TurnRecorder {
  if (!isDatabaseConfigured(env) || env.supabaseServiceRoleKey.trim() === "") {
    return new DisabledTurnRecorder();
  }
  const client = createServiceRoleClient(env);
  if (!client) return new DisabledTurnRecorder();
  return new SupabaseTurnRecorder(client);
}

/** Build the record the pipeline's own outcome implies. Pure, so it is testable. */
export function toTurnRecord(
  outcome: {
    internalState: InternalAnswerState;
    reason: AnswerReason;
    citations: Citation[];
    provenance: { modelId: string | null; embeddingModel: string; verification: "none" | "model_assisted" };
    evidence: { source: "supabase" | "fixture" };
  },
  input: { courseId: string; question: string; boundarySeconds: number; scopeMode: ScopeMode },
  latencyMs: number,
): TurnRecord {
  return {
    courseId: input.courseId,
    question: input.question,
    boundarySeconds: input.boundarySeconds,
    scopeMode: input.scopeMode,
    evidenceIds: [...new Set(outcome.citations.map((citation) => citation.evidenceId))],
    citations: outcome.citations,
    internalAnswerState: outcome.internalState,
    reason: outcome.reason,
    modelId: outcome.provenance.modelId,
    embeddingModel: outcome.provenance.embeddingModel,
    verification: outcome.provenance.verification,
    evidenceSource: outcome.evidence.source,
    latencyMs,
  };
}
