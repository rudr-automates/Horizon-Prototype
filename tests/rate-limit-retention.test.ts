import { describe, expect, it, vi } from "vitest";
import { QUESTION_LIMITS } from "@/lib/rate-limit";
import {
  DEFAULT_RETENTION_SECONDS,
  MAX_RATE_LIMIT_WINDOW_SECONDS,
  isWindowActive,
  planRateLimitRetention,
  pruneExpiredRateLimits,
  type PruneRow,
  type RetentionGateway,
} from "@/lib/rate-limit/retention";

/**
 * Retention is the only destructive operation in this subsystem, and the one
 * mistake that matters is deleting a window that is still running: that would
 * hand a client back allowance it had already spent. These cases pin the
 * arithmetic and the "never an active window" property, for EVERY configured
 * window rather than just the widest one.
 */

const NOW = new Date("2026-10-19T12:00:00.000Z");

function makeGateway() {
  const countEligible = vi.fn<(cutoffIso: string) => Promise<number>>(async () => 3);
  const deleteEligible = vi.fn<(cutoffIso: string) => Promise<PruneRow[]>>(async () => []);
  const gateway: RetentionGateway = { countEligible, deleteEligible };
  return { gateway, countEligible, deleteEligible };
}

describe("retention cutoff", () => {
  it("keeps the widest window in the arithmetic so every window is covered", () => {
    expect(MAX_RATE_LIMIT_WINDOW_SECONDS).toBe(
      Math.max(...QUESTION_LIMITS.map((window) => window.windowSeconds)),
    );

    const plan = planRateLimitRetention(NOW);
    expect(plan.cutoff.toISOString()).toBe(
      new Date(
        NOW.getTime() -
          (DEFAULT_RETENTION_SECONDS + MAX_RATE_LIMIT_WINDOW_SECONDS) * 1000,
      ).toISOString(),
    );
  });

  it("can never select a row whose window is still active", () => {
    const retention = DEFAULT_RETENTION_SECONDS;
    const plan = planRateLimitRetention(NOW, retention);
    // The newest instant a selectable row could start, and the widest window it
    // could belong to — the least favourable case for the claim.
    const latestSelectable = new Date(plan.cutoff.getTime() - 1);

    for (const window of QUESTION_LIMITS) {
      expect(isWindowActive(latestSelectable, window.windowSeconds, NOW)).toBe(false);
      expect(
        latestSelectable.getTime() + window.windowSeconds * 1000,
      ).toBeLessThanOrEqual(NOW.getTime() - retention * 1000);
    }
  });

  it("still refuses to touch a running window when retention is zero", () => {
    const plan = planRateLimitRetention(NOW, 0);
    const latestSelectable = new Date(plan.cutoff.getTime() - 1);

    for (const window of QUESTION_LIMITS) {
      expect(isWindowActive(latestSelectable, window.windowSeconds, NOW)).toBe(false);
    }
  });

  it("treats a window that ends exactly now as closed", () => {
    const start = new Date(NOW.getTime() - 600 * 1000);
    expect(isWindowActive(start, 600, NOW)).toBe(false);
    expect(isWindowActive(new Date(NOW.getTime() - 599 * 1000), 600, NOW)).toBe(true);
  });

  it("refuses a retention that would move the cutoff into the future", () => {
    expect(() => planRateLimitRetention(NOW, -1)).toThrow(/non-negative/);
    expect(() => planRateLimitRetention(NOW, Number.NaN)).toThrow(/finite/);
  });
});

describe("pruning", () => {
  it("is a dry run unless --apply was given, and still reports the eligibility", async () => {
    const { gateway, countEligible, deleteEligible } = makeGateway();

    const result = await pruneExpiredRateLimits(gateway, { now: NOW });

    expect(result.applied).toBe(false);
    expect(result.eligible).toBe(3);
    expect(result.deleted).toBe(0);
    expect(countEligible).toHaveBeenCalledTimes(1);
    expect(deleteEligible).not.toHaveBeenCalled();
    expect(countEligible.mock.calls[0]?.[0]).toBe(result.cutoff);
  });

  it("deletes only rows before the cutoff and reports how many", async () => {
    const closed: PruneRow[] = [
      {
        bucket_key: "a".repeat(64),
        window_seconds: 600,
        window_start: new Date(NOW.getTime() - 5 * 86_400_000).toISOString(),
      },
      {
        bucket_key: "b".repeat(64),
        window_seconds: 86_400,
        window_start: new Date(NOW.getTime() - 10 * 86_400_000).toISOString(),
      },
    ];
    const { gateway, deleteEligible } = makeGateway();
    deleteEligible.mockResolvedValue(closed);

    const result = await pruneExpiredRateLimits(gateway, { now: NOW, apply: true });

    expect(result.applied).toBe(true);
    expect(result.deleted).toBe(2);
    expect(deleteEligible).toHaveBeenCalledTimes(1);
    expect(deleteEligible.mock.calls[0]?.[0]).toBe(result.cutoff);
  });

  it("fails loudly if a delete ever returns an active window", async () => {
    const active: PruneRow[] = [
      {
        bucket_key: "c".repeat(64),
        window_seconds: 600,
        window_start: new Date(NOW.getTime() - 60_000).toISOString(),
      },
    ];
    const { gateway, deleteEligible } = makeGateway();
    deleteEligible.mockResolvedValue(active);

    await expect(
      pruneExpiredRateLimits(gateway, { now: NOW, apply: true }),
    ).rejects.toThrow(/still active/);
  });

  it("does not swallow a database error", async () => {
    const { gateway, countEligible } = makeGateway();
    countEligible.mockRejectedValue(new Error("rate-limit prune count failed: PGRST205"));

    await expect(pruneExpiredRateLimits(gateway, { now: NOW })).rejects.toThrow(
      /prune count failed/,
    );
  });
});
