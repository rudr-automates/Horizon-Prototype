import type { SupabaseClient } from "@supabase/supabase-js";
import {
  count,
  entryTotalTokens,
  reportedTotal,
  utcDayKey,
  type EmbeddingAdmissionDecision,
  type EmbeddingAdmissionRequest,
  type GenerationAdmissionRequest,
  type GenerationReservation,
  type ProviderCallEvidence,
  type ReportedUsage,
  type ReservationDecision,
  type SettlementResult,
  type UsageEntry,
  type UsageLedger,
} from "@/lib/usage/types";

/**
 * Database-backed usage ledger, built on the atomic admission functions added
 * by migration 0003.
 *
 * WHY THIS SHAPE
 *   Reading the day's total and then inserting a record are two round trips, so
 *   two concurrent turns could both see the same remaining budget and both be
 *   admitted. Every admission decision here is delegated to ONE SQL statement
 *   that takes an advisory transaction lock, so serialization happens in the
 *   database rather than being assumed in the application.
 *
 * FAIL CLOSED
 *   Every method throws on any error. A caller that cannot distinguish "0 used"
 *   from "could not read" must not spend, and swallowing an error here would
 *   silently disable the cap. The pipeline turns a throw into a refusal.
 *
 * WHAT IT DOES NOT CLAIM
 *   The embedding path is bounded by REQUEST COUNT, not by cost. The embeddings
 *   API reports no token usage, so no honest cost figure exists to enforce.
 */

export class UsageLedgerFailure extends Error {
  readonly operation: string;

  constructor(operation: string, message: string) {
    super(message);
    this.name = "UsageLedgerFailure";
    this.operation = operation;
  }
}

export interface GenerationAdmissionRow {
  admitted: boolean;
  reservation_id: string | null;
  spent_tokens: number | string | null;
  reserved_tokens: number | string | null;
  detail: string | null;
}

export interface EmbeddingAdmissionRow {
  admitted: boolean;
  used_today: number | string | null;
  detail: string | null;
}

export interface SettlementRow {
  charged_tokens: number | string | null;
  reported_tokens: number | string | null;
  outcome: string | null;
  detail: string | null;
}

export interface UsageRow {
  state: string | null;
  charged_tokens: number | string | null;
  reserved_tokens: number | string | null;
}

export interface UsageGateway {
  /** Settled spend and outstanding held capacity for one UTC day. */
  dayTotals(day: string): Promise<{ settledTokens: number; reservedTokens: number }>;
  /** Embedding REQUEST rows recorded for one UTC day, across all providers. */
  embeddingRequestsForDay(day: string): Promise<number>;
  admitGenerationTokens(input: {
    budgetTokens: number;
    reserveTokens: number;
    provider: string;
    modelId: string | null;
    operation: string;
  }): Promise<GenerationAdmissionRow>;
  admitEmbeddingRequest(input: {
    maxCalls: number;
    provider: string;
    modelId: string | null;
  }): Promise<EmbeddingAdmissionRow>;
  settleReservation(input: {
    reservationId: string;
    promptTokens: number | null;
    completionTokens: number | null;
    reasoningTokens: number | null;
    failed: boolean;
    detail: string | null;
    notBillable: boolean;
  }): Promise<SettlementRow>;
  insert(row: Record<string, unknown>): Promise<void>;
  /** Newest settled call the provider reported usage for, or null. */
  latestReportedGeneration(): Promise<{
    settled_at: string | null;
    occurred_at: string | null;
    day: string | null;
    provider: string | null;
    model_id: string | null;
    operation: string | null;
  } | null>;
}

function toCount(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return count(parsed);
}

/**
 * The row written for one metered call that never held a reservation.
 *
 * `charged_tokens` is the authoritative figure, and it equals
 * `entryTotalTokens(entry)` — the same sum the in-memory ledger uses, so a mode
 * switch cannot change what counts as spend. Reasoning tokens are ALSO stored in
 * their own column now that 0003 adds one; before that they had to be folded
 * into `completion_tokens` to survive at all.
 */
export function usageRow(entry: UsageEntry): Record<string, unknown> {
  return {
    kind: "generation_tokens",
    state: "settled",
    day: utcDayKey(),
    provider: entry.provider,
    // The column exists only from migration 0003 onward; before it, the value
    // had nowhere to go and was dropped rather than smuggled into another field.
    operation: entry.operation,
    model_id: entry.modelId,
    request_id: entry.requestId,
    turn_id: entry.turnId,
    prompt_tokens: count(entry.promptTokens),
    completion_tokens: count(entry.completionTokens),
    reasoning_tokens: count(entry.reasoningTokens),
    charged_tokens: entryTotalTokens(entry),
    reserved_tokens: 0,
    outcome: "reported",
    // Left NULL deliberately: a cost figure without a dated price source
    // would understate spend.
    estimated_cost_usd: null,
    price_source_date: null,
  };
}

export class SupabaseUsageLedger implements UsageLedger {
  readonly mode = "supabase" as const;

  constructor(private readonly gateway: UsageGateway) {}

  async spentToday(): Promise<number> {
    const totals = await this.gateway.dayTotals(utcDayKey());
    // Settled spend plus capacity currently held by in-flight calls.
    return totals.settledTokens + totals.reservedTokens;
  }

  /** Read from the durable count, never from an admission decision's `usedToday`. */
  async embeddingRequestsToday(): Promise<number> {
    return this.gateway.embeddingRequestsForDay(utcDayKey());
  }

  async admitGeneration(request: GenerationAdmissionRequest): Promise<ReservationDecision> {
    const row = await this.gateway.admitGenerationTokens({
      budgetTokens: request.budgetTokens,
      reserveTokens: Math.max(0, count(request.reserveTokens)),
      provider: request.provider,
      modelId: request.modelId,
      operation: request.operation,
    });

    const spentTokens = toCount(row.spent_tokens);
    const reservedTokens = toCount(row.reserved_tokens);
    const detail = row.detail ?? "";

    if (!row.admitted || !row.reservation_id) {
      return { admitted: false, reservation: null, spentTokens, reservedTokens, detail };
    }

    return {
      admitted: true,
      reservation: {
        id: row.reservation_id,
        kind: "generation_tokens",
        reservedTokens: Math.max(0, count(request.reserveTokens)),
      },
      spentTokens,
      reservedTokens,
      detail,
    };
  }

  async admitEmbedding(request: EmbeddingAdmissionRequest): Promise<EmbeddingAdmissionDecision> {
    const row = await this.gateway.admitEmbeddingRequest({
      maxCalls: Math.max(0, Math.floor(count(request.maxCalls))),
      provider: request.provider,
      modelId: request.modelId,
    });

    return {
      admitted: row.admitted,
      usedToday: toCount(row.used_today),
      detail: row.detail ?? "",
    };
  }

  async settle(
    reservation: GenerationReservation,
    reported: ReportedUsage | null,
    options: { failed?: boolean; detail?: string; notBillable?: boolean } = {},
  ): Promise<SettlementResult> {
    const row = await this.gateway.settleReservation({
      reservationId: reservation.id,
      promptTokens: reported?.promptTokens ?? null,
      completionTokens: reported?.completionTokens ?? null,
      reasoningTokens: reported?.reasoningTokens ?? null,
      failed: options.failed ?? false,
      detail: options.detail ?? null,
      notBillable: options.notBillable ?? false,
    });

    return {
      chargedTokens: toCount(row.charged_tokens),
      reportedTokens: toCount(row.reported_tokens) || reportedTotal(reported),
      outcome: (row.outcome ?? "unknown") as SettlementResult["outcome"],
      detail: row.detail ?? "",
    };
  }

  async record(entry: UsageEntry): Promise<void> {
    await this.gateway.insert(usageRow(entry));
  }

  /**
   * Read the newest settled, REPORTED generation row.
   *
   * `outcome = 'reported'` is the load-bearing filter: it is only written when
   * the provider returned usage, so a reservation that collapsed to zero after a
   * failed call cannot be mistaken for a working one. A row charged at its own
   * reservation (`no_report_charged_reservation`) is excluded for the same
   * reason — it means nothing came back.
   */
  async providerCallEvidence(): Promise<ProviderCallEvidence> {
    const row = await this.gateway.latestReportedGeneration();
    if (!row) return { state: "none_recorded" };
    const at = row.settled_at ?? row.occurred_at;
    if (!at) return { state: "none_recorded" };
    return {
      state: "observed",
      at,
      provider: row.provider ?? "unknown",
      modelId: row.model_id,
      operation: row.operation,
      today: row.day === utcDayKey(),
    };
  }
}

/** Build a UsageGateway from a Supabase service-role client. */
export function createSupabaseUsageGateway(client: SupabaseClient): UsageGateway {
  async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.rpc(fn, args);
    if (error) {
      throw new UsageLedgerFailure(
        fn,
        `Database function ${fn} failed: ${error.message}. Confirm migration 0003 is applied.`,
      );
    }
    // A function declared `returns table (...)` comes back as an array with one
    // row. Anything else means the shim changed shape, which must not be read as
    // a successful admission.
    const rows = Array.isArray(data) ? data : [data];
    if (!rows[0]) {
      throw new UsageLedgerFailure(fn, `Database function ${fn} returned no row.`);
    }
    return rows[0] as T;
  }

  return {
    async dayTotals(day: string) {
      // Range-select rather than SUM: PostgREST cannot aggregate without a
      // server-side function. Acceptable at demo volume; a dated aggregate RPC is
      // the right follow-up once the ledger is large.
      const { data, error } = await client
        .from("usage_ledger")
        .select("state, charged_tokens, reserved_tokens")
        .eq("day", day);

      if (error) {
        throw new UsageLedgerFailure(
          "day_totals",
          `Could not read today's usage: ${error.message}. Confirm migrations 0001 and 0003 are applied.`,
        );
      }

      let settledTokens = 0;
      let reservedTokens = 0;
      for (const row of (data ?? []) as UsageRow[]) {
        if (row.state === "reserved") reservedTokens += toCount(row.reserved_tokens);
        else settledTokens += toCount(row.charged_tokens);
      }
      return { settledTokens, reservedTokens };
    },

    async embeddingRequestsForDay(day: string) {
      // Counts embedding rows for the day across every provider. This is the
      // same predicate `horizon_admit_embedding_request` counts, so the figure
      // REPORTED and the figure ENFORCED cannot drift apart.
      const { count, error } = await client
        .from("usage_ledger")
        .select("id", { count: "exact", head: true })
        .eq("day", day)
        .eq("kind", "embedding_request");

      if (error) {
        throw new UsageLedgerFailure(
          "embedding_request_count",
          `Could not read the day's embedding requests: ${error.message}. Confirm migrations 0001 and 0003 are applied.`,
        );
      }
      return count ?? 0;
    },

    admitGenerationTokens: (input) =>
      rpc<GenerationAdmissionRow>("horizon_admit_generation_tokens", {
        p_budget_tokens: input.budgetTokens,
        p_reserve_tokens: input.reserveTokens,
        p_provider: input.provider,
        p_model_id: input.modelId,
        p_operation: input.operation,
      }),

    admitEmbeddingRequest: (input) =>
      rpc<EmbeddingAdmissionRow>("horizon_admit_embedding_request", {
        p_max_calls: input.maxCalls,
        p_provider: input.provider,
        p_model_id: input.modelId,
      }),

    settleReservation: (input) =>
      rpc<SettlementRow>("horizon_settle_reservation", {
        p_reservation_id: input.reservationId,
        p_prompt_tokens: input.promptTokens,
        p_completion_tokens: input.completionTokens,
        p_reasoning_tokens: input.reasoningTokens,
        p_failed: input.failed,
        p_detail: input.detail,
        p_not_billable: input.notBillable,
      }),

    async insert(row: Record<string, unknown>) {
      const { error } = await client.from("usage_ledger").insert(row);
      if (error) {
        throw new UsageLedgerFailure(
          "insert_usage",
          `Could not record usage: ${error.message}.`,
        );
      }
    },

    async latestReportedGeneration() {
      // Across every day, not only today: a call that succeeded yesterday is
      // still evidence that the credential works, and the caller decides how to
      // describe that. `settled_at` may be null on a pre-0003 row, so the
      // ordering falls back to the row's own timestamp by taking the newest
      // non-null of either in the caller.
      const { data, error } = await client
        .from("usage_ledger")
        .select("settled_at, occurred_at, day, provider, model_id, operation")
        .eq("kind", "generation_tokens")
        .eq("state", "settled")
        .eq("outcome", "reported")
        .order("settled_at", { ascending: false })
        .limit(1);

      if (error) {
        throw new UsageLedgerFailure(
          "provider_call_evidence",
          `Could not read the provider-call record: ${error.message}.`,
        );
      }
      const rows = (data ?? []) as Array<{
        settled_at: string | null;
        occurred_at: string | null;
        day: string | null;
        provider: string | null;
        model_id: string | null;
        operation: string | null;
      }>;
      return rows[0] ?? null;
    },
  };
}
