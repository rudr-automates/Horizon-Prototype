import type { SupabaseClient } from "@supabase/supabase-js";
import { count, entryTotalTokens, utcDayStart, type UsageEntry, type UsageLedger } from "@/lib/usage/types";

/**
 * Database-backed usage ledger, reading and writing `public.usage_ledger`.
 *
 * This is the durable form of the daily cap: the total survives restarts and is
 * shared by every server instance. It requires the migration to have been
 * applied; when the table is missing, every call throws and the pipeline fails
 * closed rather than spending unmetered.
 */

export class UsageLedgerFailure extends Error {
  readonly operation: string;

  constructor(operation: string, message: string) {
    super(message);
    this.name = "UsageLedgerFailure";
    this.operation = operation;
  }
}

export interface UsageGateway {
  /** Sum of prompt+completion tokens recorded at or after the instant. */
  sumTokensSince(isoInstant: string): Promise<number>;
  insert(row: Record<string, unknown>): Promise<void>;
}

export interface UsageRow {
  prompt_tokens: number | string | null;
  completion_tokens: number | string | null;
}

function toCount(value: number | string | null): number {
  if (value === null) return 0;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return count(parsed);
}

/**
 * The row written for one metered call.
 *
 * `sumTokensSince` reads only `prompt_tokens + completion_tokens`, so the row
 * MUST sum to the same figure the admission check counted. The reasoning tokens
 * are therefore folded into `completion_tokens` rather than dropped: persisting
 * the visible completion alone made the daily cap count tens of times less than
 * the provider billed, while `spentToday()` still returned a plausible number.
 * `completion_tokens` is derived from the total instead of recomputed from its
 * parts, so the equality below holds by construction rather than by convention:
 *
 *   prompt_tokens + completion_tokens === entryTotalTokens(entry)
 *
 * The schema has no reasoning column, and adding one would invalidate the
 * migration an operator has already applied, so the split stays in this comment
 * and the total is what is persisted. A `reasoning_tokens` column is the honest
 * follow-up.
 */
export function usageRow(entry: UsageEntry): Record<string, unknown> {
  const promptTokens = count(entry.promptTokens);
  return {
    provider: entry.provider,
    model_id: entry.modelId,
    request_id: entry.requestId,
    turn_id: entry.turnId,
    prompt_tokens: promptTokens,
    completion_tokens: Math.max(0, entryTotalTokens(entry) - promptTokens),
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
    // The gateway sums server rows and throws on failure; the pipeline fails
    // closed on that throw, so a wrong number is never used as a limit.
    return this.gateway.sumTokensSince(utcDayStart());
  }

  async record(entry: UsageEntry): Promise<void> {
    await this.gateway.insert(usageRow(entry));
  }
}

/** Build a UsageGateway from a Supabase service-role client. */
export function createSupabaseUsageGateway(client: SupabaseClient): UsageGateway {
  return {
    async sumTokensSince(isoInstant: string): Promise<number> {
      // Range-select rather than COUNT/SUM: PostgREST cannot aggregate without a
      // server-side function. Acceptable at demo volume; a dated aggregate RPC
      // is the right follow-up once the ledger is large.
      const { data, error } = await client
        .from("usage_ledger")
        .select("prompt_tokens, completion_tokens")
        .gte("occurred_at", isoInstant);

      if (error) {
        throw new UsageLedgerFailure(
          "sum_usage",
          `Could not read today's usage: ${error.message}. Confirm both migrations are applied.`,
        );
      }

      return (data ?? []).reduce(
        (total: number, row: UsageRow) =>
          total + toCount(row.prompt_tokens) + toCount(row.completion_tokens),
        0,
      );
    },

    async insert(row: Record<string, unknown>): Promise<void> {
      const { error } = await client.from("usage_ledger").insert(row);
      if (error) {
        throw new UsageLedgerFailure(
          "insert_usage",
          `Could not record usage: ${error.message}.`,
        );
      }
    },
  };
}
