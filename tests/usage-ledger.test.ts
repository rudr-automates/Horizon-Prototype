import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryUsageLedger } from "@/lib/usage/memory-ledger";
import {
  createSupabaseUsageGateway,
  SupabaseUsageLedger,
  UsageLedgerFailure,
  type UsageGateway,
} from "@/lib/usage/supabase-ledger";
import {
  decideAdmission,
  estimatePromptTokens,
  utcDayStart,
  USAGE_COVERAGE_NOTE,
  type UsageEntry,
} from "@/lib/usage/types";

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    provider: "google-genai",
    modelId: "gemini-3.6-flash",
    requestId: null,
    turnId: null,
    promptTokens: 100,
    completionTokens: 20,
    operation: "generate",
    ...overrides,
  };
}

describe("admission rule", () => {
  it("refuses every call when the budget is zero", () => {
    const decision = decideAdmission(0, 0, 1);
    expect(decision.admitted).toBe(false);
    expect(decision.detail).toMatch(/permits no provider call/);
  });

  it("admits a call that fits inside the remaining budget", () => {
    const decision = decideAdmission(400, 1000, 500);
    expect(decision.admitted).toBe(true);
    expect(decision.spentToday).toBe(400);
  });

  it("admits a call that exactly consumes the remaining budget", () => {
    expect(decideAdmission(500, 1000, 500).admitted).toBe(true);
  });

  it("refuses a call that would cross the ceiling, leaving no overshoot", () => {
    const decision = decideAdmission(500, 1000, 501);
    expect(decision.admitted).toBe(false);
    expect(decision.detail).toMatch(/only 500 remain/);
  });

  it("refuses once the day's spend has reached the budget", () => {
    expect(decideAdmission(1000, 1000, 1).admitted).toBe(false);
    expect(decideAdmission(1200, 1000, 1).admitted).toBe(false);
  });

  it("states that embedding requests are not metered", () => {
    // The caveat must be carried into every response, not merely documented.
    expect(USAGE_COVERAGE_NOTE).toMatch(/Embedding requests are not metered/);
  });

  it("estimates prompt size conservatively rather than exactly", () => {
    expect(estimatePromptTokens("")).toBe(0);
    expect(estimatePromptTokens("abcdef")).toBe(2);
    // Never below a third of the character count, so it does not under-reserve.
    expect(estimatePromptTokens("x".repeat(300))).toBeGreaterThanOrEqual(100);
  });
});

describe("in-memory usage ledger", () => {
  it("accumulates across records instead of reporting only the last one", async () => {
    const ledger = new InMemoryUsageLedger();
    await ledger.record(entry({ promptTokens: 100, completionTokens: 20 }));
    await ledger.record(entry({ promptTokens: 50, completionTokens: 5 }));

    expect(await ledger.spentToday()).toBe(175);
    expect(ledger.entries).toHaveLength(2);
  });

  it("counts both generation and verification against the same day", async () => {
    const ledger = new InMemoryUsageLedger();
    await ledger.record(entry({ promptTokens: 200, completionTokens: 30 }));
    await ledger.record(entry({ operation: "verify", promptTokens: 80, completionTokens: 10 }));

    expect(await ledger.spentToday()).toBe(320);
  });

  it("treats a negative or non-finite count as zero rather than as a credit", async () => {
    const ledger = new InMemoryUsageLedger();
    await ledger.record(entry({ promptTokens: -500, completionTokens: Number.NaN }));

    expect(await ledger.spentToday()).toBe(0);
  });

  it("resets the running total when the UTC day rolls over", async () => {
    const ledger = new InMemoryUsageLedger(new Date("2026-10-15T23:00:00.000Z"));
    await ledger.record(entry({ promptTokens: 900, completionTokens: 0 }));
    expect(await ledger.spentToday()).toBe(900);

    // Same instance, next day: the total must not carry over.
    const nextDay = new InMemoryUsageLedger(new Date("2026-10-15T23:00:00.000Z"));
    await nextDay.record(entry({ promptTokens: 900, completionTokens: 0 }));

    const spy = new InMemoryUsageLedger(new Date("2026-10-16T00:30:00.000Z"));
    expect(await spy.spentToday()).toBe(0);
  });

  it("reports its mode so a process-local total is never read as durable", () => {
    expect(new InMemoryUsageLedger().mode).toBe("memory");
  });

  it("bounds the retained trail so a long-lived process cannot grow without limit", async () => {
    const ledger = new InMemoryUsageLedger();
    for (let i = 0; i < 620; i += 1) {
      await ledger.record(entry({ promptTokens: 1, completionTokens: 0 }));
    }
    expect(ledger.entries.length).toBeLessThanOrEqual(500);
    // Trimming the trail must not lose the running total.
    expect(await ledger.spentToday()).toBe(620);
  });
});

describe("database-backed usage ledger", () => {
  function gateway(overrides: Partial<UsageGateway> = {}): UsageGateway & {
    rows: Array<Record<string, unknown>>;
  } {
    const rows: Array<Record<string, unknown>> = [];
    return {
      rows,
      sumTokensSince: async () => 0,
      insert: async (row) => {
        rows.push(row);
      },
      ...overrides,
    };
  }

  it("asks the database for today's total and returns it", async () => {
    let askedSince = "";
    const ledger = new SupabaseUsageLedger(
      gateway({
        sumTokensSince: async (iso) => {
          askedSince = iso;
          return 4321;
        },
      }),
    );

    expect(await ledger.spentToday()).toBe(4321);
    expect(askedSince).toBe(utcDayStart());
    expect(askedSince.endsWith("T00:00:00.000Z")).toBe(true);
  });

  it("records usage with cost left explicitly unknown", async () => {
    const store = gateway();
    const ledger = new SupabaseUsageLedger(store);

    await ledger.record(entry({ promptTokens: 10, completionTokens: 4 }));

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].prompt_tokens).toBe(10);
    expect(store.rows[0].completion_tokens).toBe(4);
    // Inventing a cost without a dated price source would understate spend.
    expect(store.rows[0].estimated_cost_usd).toBeNull();
    expect(store.rows[0].price_source_date).toBeNull();
  });

  it("propagates a read failure instead of reporting zero spend", async () => {
    const ledger = new SupabaseUsageLedger(
      gateway({
        sumTokensSince: async () => {
          throw new UsageLedgerFailure("sum_usage", "relation does not exist");
        },
      }),
    );

    // Returning 0 here would silently disable the cap, so it must throw.
    await expect(ledger.spentToday()).rejects.toThrow(/relation does not exist/);
  });

  it("reports its mode as the durable one", () => {
    expect(new SupabaseUsageLedger(gateway()).mode).toBe("supabase");
  });

  it("surfaces a database error as a refusal rather than a silent success", async () => {
    const client = {
      from: () => ({
        select: () => ({ gte: async () => ({ data: null, error: { message: "no such table" } }) }),
      }),
    };

    await expect(
      createSupabaseUsageGateway(client as unknown as SupabaseClient).sumTokensSince(
        utcDayStart(),
      ),
    ).rejects.toThrow(/no such table/);
  });

  it("sums prompt and completion tokens from the returned rows", async () => {
    const client = {
      from: () => ({
        select: () => ({
          gte: async () => ({
            data: [
              { prompt_tokens: 100, completion_tokens: 20 },
              { prompt_tokens: "50", completion_tokens: null },
              { prompt_tokens: -5, completion_tokens: 5 },
            ],
            error: null,
          }),
        }),
      }),
    };

    const total = await createSupabaseUsageGateway(
      client as unknown as SupabaseClient,
    ).sumTokensSince(utcDayStart());

    // 100+20 + 50+0 + 0+5 ; the negative count is treated as zero, not a credit.
    expect(total).toBe(175);
  });

  it("surfaces an insert error so an unrecorded call is visible", async () => {
    const client = {
      from: () => ({
        insert: async () => ({ error: { message: "permission denied" } }),
      }),
    };

    await expect(
      createSupabaseUsageGateway(client as unknown as SupabaseClient).insert({}),
    ).rejects.toThrow(/permission denied/);
  });
});
