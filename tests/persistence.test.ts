import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTurnRecorder,
  DisabledTurnRecorder,
  SupabaseTurnRecorder,
  toTurnRecord,
  type TurnRecord,
} from "@/lib/persistence/turns";
import { makeEnv } from "./helpers/fakes";

const baseTurn: TurnRecord = {
  courseId: "course_1",
  question: "How does backoff grow?",
  boundarySeconds: 300,
  scopeMode: "POSITION",
  evidenceIds: ["b_0003"],
  citations: [
    {
      evidenceId: "b_0003",
      sourceLabel: "PDF page 3",
      blockType: "pdf",
      startSeconds: null,
      endSeconds: null,
      pageNumber: 3,
      slideNumber: null,
      lineStart: null,
      lineEnd: null,
      policy: "TIMELINE_BOUND",
      quote: "by a base factor",
    },
  ],
  internalAnswerState: "ANSWERED",
  reason: "NONE",
  modelId: "gemini-3.6-flash",
  embeddingModel: "gemini-embedding-001",
  verification: "model_assisted",
  evidenceSource: "supabase",
  latencyMs: 812,
};

interface CapturedInsert {
  table: string;
  values: Record<string, unknown>;
}

/**
 * Minimal fake of the supabase-js builder chain used by SupabaseTurnRecorder.
 * `failOn` makes a specific table's write fail so fail-safe behaviour is real.
 */
function fakeClient(options: { existingConversation?: string | null; failOn?: string } = {}) {
  const inserts: CapturedInsert[] = [];

  function from(table: string) {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () =>
        Promise.resolve({
          data:
            table === "conversations" && options.existingConversation
              ? [{ id: options.existingConversation }]
              : table === "turns"
                ? []
                : [],
          error: null,
        }),
      insert: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        const error = options.failOn === table ? { message: "boom" } : null;
        return {
          select: () => ({
            maybeSingle: () => Promise.resolve({ data: error ? null : { id: "conv_1" }, error }),
          }),
          then: (resolve: (value: { error: unknown }) => unknown) =>
            Promise.resolve({ error }).then(resolve),
        };
      },
    };
    return builder;
  }

  return { client: { from } as unknown as SupabaseClient, inserts };
}

describe("turn persistence is honest about what it stored", () => {
  it("reports not-persisted, with a reason, when no database is configured", async () => {
    const recorder = createTurnRecorder(makeEnv());
    expect(recorder.mode).toBe("disabled");

    const outcome = await recorder.record(baseTurn);
    expect(outcome.persisted).toBe(false);
    expect(outcome.detail).toMatch(/not stored/i);
  });

  it("never writes a fixture-backed turn as if it were a database course", async () => {
    const { client, inserts } = fakeClient();
    const recorder = new SupabaseTurnRecorder(client);

    const outcome = await recorder.record({ ...baseTurn, evidenceSource: "fixture" });

    expect(outcome.persisted).toBe(false);
    expect(outcome.detail).toMatch(/sample fixture corpus/);
    expect(inserts).toHaveLength(0);
  });

  it("stores a database-backed turn and reports persisted: true", async () => {
    const { client, inserts } = fakeClient({ existingConversation: "conv_existing" });
    const recorder = new SupabaseTurnRecorder(client);

    const outcome = await recorder.record(baseTurn);

    expect(outcome.persisted).toBe(true);
    const turnInsert = inserts.find((insert) => insert.table === "turns");
    expect(turnInsert).toBeDefined();
    expect(turnInsert?.values.conversation_id).toBe("conv_existing");
    expect(turnInsert?.values.sequence).toBe(0);
    expect(turnInsert?.values.answer_state).toBe("ANSWERED");
    expect(turnInsert?.values.evidence_ids).toEqual(["b_0003"]);
  });

  it("keeps the INTERNAL answer state in the row, not the collapsed public one", async () => {
    const { client, inserts } = fakeClient({ existingConversation: "conv_existing" });
    const recorder = new SupabaseTurnRecorder(client);

    await recorder.record({
      ...baseTurn,
      internalAnswerState: "NOT_AVAILABLE_YET",
      reason: "NO_ELIGIBLE_EVIDENCE",
      citations: [],
      evidenceIds: [],
    });

    const turnInsert = inserts.find((insert) => insert.table === "turns");
    expect(turnInsert?.values.answer_state).toBe("NOT_AVAILABLE_YET");
    expect(turnInsert?.values.reason_code).toBe("NO_ELIGIBLE_EVIDENCE");
  });

  it("fails safe and reports the truth when the write errors", async () => {
    const { client } = fakeClient({ existingConversation: "conv_existing", failOn: "turns" });
    const recorder = new SupabaseTurnRecorder(client);

    const outcome = await recorder.record(baseTurn);

    expect(outcome.persisted).toBe(false);
    expect(outcome.detail).toMatch(/could not be written/i);
  });

  it("fails safe when the client throws", async () => {
    const throwing = {
      from: () => {
        throw new Error("network down");
      },
    } as unknown as SupabaseClient;

    const outcome = await new SupabaseTurnRecorder(throwing).record(baseTurn);
    expect(outcome.persisted).toBe(false);
  });
});

describe("toTurnRecord", () => {
  it("derives the stored turn from the pipeline outcome", () => {
    const record = toTurnRecord(
      {
        internalState: "ANSWERED_PARTIAL",
        reason: "NONE",
        citations: [
          { ...baseTurn.citations[0] },
          { ...baseTurn.citations[0] },
        ],
        provenance: {
          modelId: "gemini-3.6-flash",
          embeddingModel: "gemini-embedding-001",
          verification: "model_assisted",
        },
        evidence: { source: "supabase" },
      },
      { courseId: "course_1", question: "q", boundarySeconds: 10, scopeMode: "PROGRESS" },
      42,
    );

    expect(record.internalAnswerState).toBe("ANSWERED_PARTIAL");
    expect(record.evidenceIds).toEqual(["b_0003"]); // de-duplicated
    expect(record.scopeMode).toBe("PROGRESS");
    expect(record.latencyMs).toBe(42);
    expect(record.evidenceSource).toBe("supabase");
  });

  it("records nothing as evidence when the turn was refused", () => {
    const record = toTurnRecord(
      {
        internalState: "NOT_IN_MATERIALS",
        reason: "UNSUPPORTED_BY_EVIDENCE",
        citations: [],
        provenance: { modelId: null, embeddingModel: "gemini-embedding-001", verification: "none" },
        evidence: { source: "fixture" },
      },
      { courseId: "c", question: "q", boundarySeconds: 0, scopeMode: "POSITION" },
      5,
    );

    expect(record.evidenceIds).toEqual([]);
    expect(record.citations).toEqual([]);
    expect(record.modelId).toBeNull();
  });
});

describe("DisabledTurnRecorder", () => {
  it("is always explicit that nothing was stored", async () => {
    const outcome = await new DisabledTurnRecorder().record(baseTurn);
    expect(outcome).toEqual({
      persisted: false,
      mode: "disabled",
      detail: "No database is configured, so this turn was not stored.",
    });
  });
});
