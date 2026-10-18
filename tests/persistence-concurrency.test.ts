import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SupabaseTurnRecorder,
  type TurnRecord,
} from "@/lib/persistence/turns";

/**
 * Turn persistence used to read the last sequence and then insert it. Two
 * questions asked at the same moment both read N, both write N+1, and the
 * unique constraint on (conversation_id, sequence) rejected one — which was
 * reported as `persisted: false`. The turn was lost even though nothing was
 * wrong except timing.
 *
 * This fake models the real constraint: a sequence already committed cannot be
 * inserted twice, and the loser must recompute. Reads are released only once
 * both callers are waiting, so the collision is deterministic rather than
 * timing-dependent.
 */
const baseTurn: TurnRecord = {
  courseId: "course_1",
  question: "Why does backoff grow?",
  boundarySeconds: 300,
  scopeMode: "POSITION",
  evidenceIds: [],
  citations: [],
  internalAnswerState: "ANSWERED",
  reason: "NONE",
  modelId: "openai/gpt-oss-20b",
  embeddingModel: "gemini-embedding-001",
  verification: "model_assisted",
  evidenceSource: "supabase",
  latencyMs: 10,
};

function racingClient(expectedReaders: number) {
  const committed = new Set<number>();
  const inserted: number[] = [];
  let conflicts = 0;
  let waiting: Array<() => void> = [];
  let gateOpen = false;

  function releaseWhenReady(): Promise<void> {
    if (gateOpen) return Promise.resolve();
    return new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length >= expectedReaders) {
        gateOpen = true;
        const callbacks = waiting;
        waiting = [];
        for (const callback of callbacks) callback();
      }
    });
  }

  function from(table: string) {
    const builder: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: async () => {
        await releaseWhenReady();
        return {
          data:
            table === "turns"
              ? committed.size === 0
                ? []
                : [{ sequence: Math.max(...committed) }]
              : [],
          error: null,
        };
      },
      insert: (values: Record<string, unknown>) => {
        if (table === "turns") {
          const sequence = Number(values.sequence);
          if (committed.has(sequence)) {
            conflicts += 1;
            return { error: { code: "23505", message: "duplicate key value" } };
          }
          committed.add(sequence);
          inserted.push(sequence);
        }
        return {
          select: () => ({
            maybeSingle: () => Promise.resolve({ data: { id: "conv_1" }, error: null }),
          }),
          then: (resolve: (value: { error: unknown }) => unknown) =>
            Promise.resolve({ error: null }).then(resolve),
        };
      },
    };
    Object.assign(builder, chain);
    return builder;
  }

  return {
    client: { from } as unknown as SupabaseClient,
    inserted,
    conflicts: () => conflicts,
    committed,
  };
}

describe("turn sequencing under concurrency", () => {
  it("stores both turns when two callers compute the same next sequence", async () => {
    // Conversations already exists, so only the turns reads are gated.
    const db = racingClient(2);
    const recorderA = new SupabaseTurnRecorder(db.client);
    const recorderB = new SupabaseTurnRecorder(db.client);

    const [a, b] = await Promise.all([
      recorderA.record(baseTurn),
      recorderB.record(baseTurn),
    ]);

    expect(a.persisted).toBe(true);
    expect(b.persisted).toBe(true);
    expect(db.conflicts()).toBe(1);
    expect([...db.committed].sort()).toEqual([0, 1]);
  });

  it("continues a conversation at the next free sequence, not at zero", async () => {
    const db = racingClient(1);
    db.committed.add(0);
    db.committed.add(1);
    const recorder = new SupabaseTurnRecorder(db.client);

    const outcome = await recorder.record(baseTurn);

    expect(outcome.persisted).toBe(true);
    expect(db.inserted).toContain(2);
  });

  it("reports an honest failure, never success, when the retry budget is exhausted", async () => {
    // A client whose reads always see sequence 0 committed and whose insert
    // always conflicts: the bounded retry must stop and say so.
    const client = {
      from: (table: string) => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: async () =>
            table === "turns"
              ? { data: [{ sequence: 0 }], error: null }
              : { data: [{ id: "conv_1" }], error: null },
          insert: () =>
            table === "turns"
              ? { error: { code: "23505", message: "duplicate key value" } }
              : {
                  select: () => ({
                    maybeSingle: () => Promise.resolve({ data: { id: "conv_1" }, error: null }),
                  }),
                },
        };
        return chain;
      },
    } as unknown as SupabaseClient;

    const outcome = await new SupabaseTurnRecorder(client).record(baseTurn);

    expect(outcome.persisted).toBe(false);
    expect(outcome.detail).toMatch(/sequence number/);
  });
});
