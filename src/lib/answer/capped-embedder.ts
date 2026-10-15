import { ProviderFailure, type Embedder, type EmbedPurpose } from "@/lib/answer/provider";

/**
 * Explicit cap on embedding REQUESTS.
 *
 * WHY THIS IS SEPARATE FROM THE TOKEN BUDGET
 *   The Gemini embeddings endpoint does not report token usage, so the daily
 *   token budget cannot meter it. Without a second control, a positive token
 *   budget would bound generation while leaving embedding spend unbounded —
 *   and a broken retrieval path could issue a request per candidate without
 *   anything stopping it.
 *
 * WHY THE COUNTER IS PROCESS-WIDE
 *   A provider bundle is built per request, so a per-instance counter would
 *   reset on every request and never bind. The counter is therefore shared for
 *   the lifetime of the process, matching the in-memory usage ledger.
 *
 * The counter is incremented BEFORE the request is sent, so a call that fails
 * still consumes budget. That is intentional: it means a retry storm cannot
 * multiply calls, and a failing call cannot be free.
 *
 * This bounds CALLS, not tokens or cost. It is not a spending cap.
 */

let embeddingCalls = 0;

/** Calls attempted since the process started (or since the last reset). */
export function embeddingCallCount(): number {
  return embeddingCalls;
}

/** Test seam. */
export function resetEmbeddingCallCount(): void {
  embeddingCalls = 0;
}

export class EmbeddingCallCapReached extends ProviderFailure {
  constructor(maxCalls: number) {
    super(
      "unavailable",
      `The embedding call cap of ${maxCalls} for this process has been reached, so no further embedding request was sent. Restart the process to reset it.`,
    );
    this.name = "EmbeddingCallCapReached";
  }
}

export class CappedEmbedder implements Embedder {
  readonly providerId: string;
  readonly dimensions: number;

  constructor(
    private readonly inner: Embedder,
    /** 0 or less means no cap is configured. */
    private readonly maxCalls: number,
  ) {
    this.providerId = inner.providerId;
    this.dimensions = inner.dimensions;
  }

  async embed(texts: string[], purpose?: EmbedPurpose): Promise<number[][]> {
    if (this.maxCalls > 0 && embeddingCalls >= this.maxCalls) {
      throw new EmbeddingCallCapReached(this.maxCalls);
    }
    embeddingCalls += 1;
    return this.inner.embed(texts, purpose);
  }
}
