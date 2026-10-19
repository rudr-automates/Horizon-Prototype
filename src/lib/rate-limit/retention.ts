import type { SupabaseClient } from "@supabase/supabase-js";
import { QUESTION_LIMITS } from "@/lib/rate-limit";

/**
 * Removal of rate-limit counters whose windows have closed.
 *
 * WHY THIS IS NOT AUTOMATIC
 *   There is no scheduled job in this revision, and the table does not prune
 *   itself. Saying otherwise would be false. The mechanism is the operator-run
 *   `pnpm prune:rate-limits` command (dry run by default, `--apply` to delete),
 *   which can be put on any scheduler.
 *
 * THE RULE THAT MATTERS
 *   An active window must never be deleted. Deleting one would reset that
 *   client's count and hand back allowance it had already spent — the opposite of
 *   what the limiter exists for. So the cutoff is derived, not guessed:
 *
 *     cutoff = now − retention − MAX_WINDOW
 *
 *   A row is eligible only when `window_start < cutoff`. For any configured
 *   window w ≤ MAX_WINDOW, that means `window_start + w < now − retention`, i.e.
 *   the window had already ended at least `retention` seconds ago. The widest
 *   window is included in the arithmetic precisely so this holds for every
 *   window, not just the common one.
 *
 *   The predicate is proven in `tests/rate-limit-retention.test.ts` for every
 *   configured window and a range of cutoffs, and the delete re-checks the rows
 *   it removed as a tripwire against a future regression.
 */

/** How long a closed window is kept. Not a promise that anything deletes it. */
export const DEFAULT_RETENTION_SECONDS = 2 * 86_400;

/** The widest window the limiter can open, used to keep the cutoff safe. */
export const MAX_RATE_LIMIT_WINDOW_SECONDS = Math.max(
  ...QUESTION_LIMITS.map((window) => window.windowSeconds),
);

export interface RetentionPlan {
  /** Rows with `window_start` strictly before this instant are eligible. */
  cutoff: Date;
  retentionSeconds: number;
  maxWindowSeconds: number;
}

/**
 * Compute the cutoff. Rejects a retention that is not a non-negative number of
 * seconds, because a NaN or negative retention would silently produce a cutoff
 * in the future — which is exactly how an active window gets deleted.
 */
export function planRateLimitRetention(
  now: Date,
  retentionSeconds: number = DEFAULT_RETENTION_SECONDS,
): RetentionPlan {
  if (!Number.isFinite(retentionSeconds) || retentionSeconds < 0) {
    throw new Error("retention must be a finite, non-negative number of seconds");
  }

  return {
    cutoff: new Date(
      now.getTime() - (retentionSeconds + MAX_RATE_LIMIT_WINDOW_SECONDS) * 1000,
    ),
    retentionSeconds,
    maxWindowSeconds: MAX_RATE_LIMIT_WINDOW_SECONDS,
  };
}

/** A window is active while its end is still in the future. */
export function isWindowActive(
  windowStart: Date,
  windowSeconds: number,
  now: Date,
): boolean {
  return windowStart.getTime() + windowSeconds * 1000 > now.getTime();
}

export interface PruneRow {
  bucket_key: string;
  window_seconds: number;
  window_start: string;
}

/**
 * The two database operations pruning needs, as a narrow interface.
 *
 * Narrow on purpose: the purge is the one destructive operation in this
 * subsystem, so what it can do is a small, explicit list rather than a whole
 * client, and the tests can prove the cutoff without a database.
 */
export interface RetentionGateway {
  countEligible(cutoffIso: string): Promise<number>;
  deleteEligible(cutoffIso: string): Promise<PruneRow[]>;
}

export interface PruneResult {
  cutoff: string;
  retentionSeconds: number;
  /** Number of rows that were eligible when the run started. */
  eligible: number;
  /** Number of rows actually removed (0 for a dry run). */
  deleted: number;
  applied: boolean;
}

/** SQLSTATE/PostgREST code check kept small, so an error is never swallowed. */
function fail(operation: string, code: string | null | undefined): never {
  throw new Error(`rate-limit prune ${operation} failed: ${code ?? "unknown"}`);
}

export function createSupabaseRetentionGateway(client: SupabaseClient): RetentionGateway {
  return {
    async countEligible(cutoffIso) {
      const { count, error } = await client
        .from("request_rate_limits")
        .select("bucket_key", { count: "exact", head: true })
        .lt("window_start", cutoffIso);
      if (error) fail("count", error.code);
      return count ?? 0;
    },

    async deleteEligible(cutoffIso) {
      const { data, error } = await client
        .from("request_rate_limits")
        .delete()
        .lt("window_start", cutoffIso)
        .select("bucket_key,window_seconds,window_start");
      if (error) fail("delete", error.code);
      return (data ?? []) as PruneRow[];
    },
  };
}

/**
 * Count, and optionally delete, expired counters.
 *
 * A dry run performs the same eligibility count and no delete. When applying,
 * every removed row is re-checked: if one of them could still be active the run
 * throws. That cannot undo the delete, but it turns a silent allowance reset into
 * a loud, diagnosable failure instead of an invisible one.
 */
export async function pruneExpiredRateLimits(
  gateway: RetentionGateway,
  options: { now?: Date; retentionSeconds?: number; apply?: boolean } = {},
): Promise<PruneResult> {
  const now = options.now ?? new Date();
  const plan = planRateLimitRetention(now, options.retentionSeconds);
  const cutoff = plan.cutoff.toISOString();

  const eligible = await gateway.countEligible(cutoff);
  if (options.apply !== true) {
    return {
      cutoff,
      retentionSeconds: plan.retentionSeconds,
      eligible,
      deleted: 0,
      applied: false,
    };
  }

  const removed = await gateway.deleteEligible(cutoff);
  for (const row of removed) {
    if (isWindowActive(new Date(row.window_start), Number(row.window_seconds), now)) {
      throw new Error(
        "rate-limit prune removed a window that is still active — the cutoff is wrong",
      );
    }
  }

  return {
    cutoff,
    retentionSeconds: plan.retentionSeconds,
    eligible,
    deleted: removed.length,
    applied: true,
  };
}
