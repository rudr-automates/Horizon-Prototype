import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { InMemoryUsageLedger } from "@/lib/usage/memory-ledger";
import {
  createSupabaseUsageGateway,
  SupabaseUsageLedger,
  UsageLedgerFailure,
  usageRow,
  type UsageGateway,
} from "@/lib/usage/supabase-ledger";
import {
  decideAdmission,
  entryTotalTokens,
  estimatePromptTokens,
  reportedTotal,
  utcDayKey,
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
    reasoningTokens: 0,
    operation: "generate",
    ...overrides,
  };
}

const GENERATION_REQUEST = {
  reserveTokens: 600,
  budgetTokens: 20_000,
  provider: "google-genai",
  modelId: "gemini-3.6-flash",
  operation: "generate" as const,
};

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

  it("states what the recorded total covers, including its limits", () => {
    // The caveats must be carried into every response, not merely documented:
    // the request cap is real, and the COST of an embedding is still unknown.
    expect(USAGE_COVERAGE_NOTE).toMatch(/including billable reasoning tokens/);
    expect(USAGE_COVERAGE_NOTE).toMatch(/Embedding requests are counted against a durable cap/);
    expect(USAGE_COVERAGE_NOTE).toMatch(/their cost is not metered/);
  });

  it("estimates prompt size conservatively rather than exactly", () => {
    expect(estimatePromptTokens("")).toBe(0);
    expect(estimatePromptTokens("abcdef")).toBe(2);
    // Never below a third of the character count, so it does not under-reserve.
    expect(estimatePromptTokens("x".repeat(300))).toBeGreaterThanOrEqual(100);
  });

  it("treats an absent usage report as unknown rather than as zero", () => {
    expect(reportedTotal(null)).toBe(0);
    expect(reportedTotal({ promptTokens: null, completionTokens: null, reasoningTokens: null })).toBe(0);
    expect(reportedTotal({ promptTokens: 1, completionTokens: 2, reasoningTokens: 3 })).toBe(6);
    // Negative and non-finite components are not credits.
    expect(reportedTotal({ promptTokens: -5, completionTokens: Number.NaN, reasoningTokens: 7 })).toBe(7);
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

  it("counts reasoning tokens, which are billed but reported separately", async () => {
    // Observed live on gemini-3.6-flash: 417 prompt / 21 visible / 984 reasoning.
    const ledger = new InMemoryUsageLedger();
    await ledger.record(entry({ promptTokens: 417, completionTokens: 21, reasoningTokens: 984 }));

    expect(await ledger.spentToday()).toBe(1422);
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

    const nextDay = new InMemoryUsageLedger(new Date("2026-10-16T00:30:00.000Z"));
    expect(await nextDay.spentToday()).toBe(0);
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

describe("reservations", () => {
  it("counts a held reservation as spend, so it cannot be spent twice", async () => {
    const ledger = new InMemoryUsageLedger();
    const decision = await ledger.admitGeneration({ ...GENERATION_REQUEST, budgetTokens: 1000 });

    expect(decision.admitted).toBe(true);
    // Nothing has been settled, yet the day already reflects the held capacity.
    expect(await ledger.spentToday()).toBe(600);
  });

  it("refuses a second reservation the same budget cannot cover", async () => {
    // 600 + 600 > 1000, so exactly one of these may succeed. This is the
    // property the previous read-then-record design did not have: nothing was
    // recorded until AFTER the call, so both reservations would have been
    // granted against the same remaining budget.
    const ledger = new InMemoryUsageLedger();
    const request = { ...GENERATION_REQUEST, budgetTokens: 1000 };

    const [first, second] = await Promise.all([
      ledger.admitGeneration(request),
      ledger.admitGeneration(request),
    ]);

    expect([first.admitted, second.admitted].filter(Boolean)).toHaveLength(1);
    expect(await ledger.spentToday()).toBe(600);
  });

  it("grants every reservation while the budget lasts, then stops", async () => {
    const ledger = new InMemoryUsageLedger();
    const request = { ...GENERATION_REQUEST, reserveTokens: 100, budgetTokens: 350 };

    const decisions = [];
    for (let i = 0; i < 5; i += 1) decisions.push(await ledger.admitGeneration(request));

    expect(decisions.filter((d) => d.admitted)).toHaveLength(3);
    expect(await ledger.spentToday()).toBe(300);
  });

  it("refuses every reservation when the budget permits no call at all", async () => {
    const decision = await new InMemoryUsageLedger().admitGeneration({
      ...GENERATION_REQUEST,
      budgetTokens: 0,
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reservation).toBeNull();
  });

  it("charges what the provider reported and releases the reservation", async () => {
    const ledger = new InMemoryUsageLedger();
    const decision = await ledger.admitGeneration({ ...GENERATION_REQUEST, budgetTokens: 20_000 });
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;

    const settled = await ledger.settle(decision.reservation, {
      promptTokens: 400,
      completionTokens: 100,
      reasoningTokens: 500,
    });

    // 400 + 100 + 500: reasoning is billed, so it is part of the charge.
    expect(settled.chargedTokens).toBe(1000);
    expect(settled.reportedTokens).toBe(1000);
    expect(settled.outcome).toBe("reported");
    // The 600-token hold is gone; only the real charge remains.
    expect(await ledger.spentToday()).toBe(1000);
  });

  it("keeps the reservation as the charge when a SENT call reports nothing", async () => {
    // A timeout is not evidence that nothing was billed. Collapsing to zero here
    // would silently erase real spend, which is the failure this policy exists
    // to prevent.
    const ledger = new InMemoryUsageLedger();
    const decision = await ledger.admitGeneration({ ...GENERATION_REQUEST, budgetTokens: 20_000 });
    if (!decision.admitted) throw new Error("expected admission");

    const settled = await ledger.settle(decision.reservation, null, { failed: true });

    expect(settled.chargedTokens).toBe(600);
    expect(settled.reportedTokens).toBe(0);
    expect(settled.outcome).toBe("failed_no_report_charged_reservation");
    expect(await ledger.spentToday()).toBe(600);
  });

  it("does not charge twice when the same reservation is settled again", async () => {
    const ledger = new InMemoryUsageLedger();
    const decision = await ledger.admitGeneration({ ...GENERATION_REQUEST, budgetTokens: 20_000 });
    if (!decision.admitted) throw new Error("expected admission");

    await ledger.settle(decision.reservation, { promptTokens: 300, completionTokens: 0, reasoningTokens: 0 });
    const second = await ledger.settle(decision.reservation, {
      promptTokens: 300,
      completionTokens: 0,
      reasoningTokens: 0,
    });

    expect(second.outcome).toBe("already_settled");
    expect(await ledger.spentToday()).toBe(300);
  });
});

describe("embedding request cap", () => {
  it("counts requests and refuses past the cap", async () => {
    const ledger = new InMemoryUsageLedger();
    const request = { maxCalls: 2, provider: "gemini-embedding-001", modelId: "gemini-3.6-flash" };

    expect((await ledger.admitEmbedding(request)).admitted).toBe(true);
    expect((await ledger.admitEmbedding(request)).admitted).toBe(true);

    const third = await ledger.admitEmbedding(request);
    expect(third.admitted).toBe(false);
    expect(third.usedToday).toBe(2);
  });

  it("treats an unconfigured cap as a refusal rather than as unlimited", async () => {
    // 0 means "no cap configured", and the durable path must not read that as
    // permission to spend without limit.
    const decision = await new InMemoryUsageLedger().admitEmbedding({
      maxCalls: 0,
      provider: "gemini-embedding-001",
      modelId: null,
    });
    expect(decision.admitted).toBe(false);
    expect(decision.detail).toMatch(/No embedding-request cap/);
  });

  it("never claims the cap bounds cost", async () => {
    const decision = await new InMemoryUsageLedger().admitEmbedding({
      maxCalls: 5,
      provider: "gemini-embedding-001",
      modelId: null,
    });
    expect(decision.detail).toMatch(/Cost is NOT bounded/);
  });

  it("reports the count of requests it actually admitted", async () => {
    // This IS the day's figure when the cap is process-local, because there is no
    // second store for it to disagree with. It counts GRANTS, not attempts: a
    // refused request must not inflate the number shown against the cap.
    const ledger = new InMemoryUsageLedger();
    const request = { maxCalls: 1, provider: "gemini-embedding-001", modelId: null };

    expect(await ledger.embeddingRequestsToday()).toBe(0);
    await ledger.admitEmbedding(request);
    expect(await ledger.embeddingRequestsToday()).toBe(1);
    expect((await ledger.admitEmbedding(request)).admitted).toBe(false);
    expect(await ledger.embeddingRequestsToday()).toBe(1);
  });
});

describe("database-backed usage ledger", () => {
  function gateway(overrides: Partial<UsageGateway> = {}): UsageGateway & {
    rows: Array<Record<string, unknown>>;
  } {
    const rows: Array<Record<string, unknown>> = [];
    return {
      rows,
      dayTotals: async () => ({ settledTokens: 0, reservedTokens: 0 }),
      embeddingRequestsForDay: async () => 0,
      admitGenerationTokens: async () => ({
        admitted: true,
        reservation_id: "11111111-1111-5111-8111-111111111111",
        spent_tokens: 0,
        reserved_tokens: 0,
        detail: "admitted",
      }),
      admitEmbeddingRequest: async () => ({ admitted: true, used_today: 1, detail: "counted" }),
      settleReservation: async () => ({
        charged_tokens: 0,
        reported_tokens: 0,
        outcome: "reported",
        detail: "",
      }),
      insert: async (row) => {
        rows.push(row);
      },
      ...overrides,
    };
  }

  it("asks the database for TODAY's totals and sums settled with held capacity", async () => {
    let askedDay = "";
    const ledger = new SupabaseUsageLedger(
      gateway({
        dayTotals: async (day) => {
          askedDay = day;
          return { settledTokens: 4000, reservedTokens: 500 };
        },
      }),
    );

    expect(await ledger.spentToday()).toBe(4500);
    expect(askedDay).toBe(utcDayKey());
    expect(askedDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("reads TODAY's embedding-request count from the durable store", async () => {
    // Read through a dedicated method rather than from `admitEmbedding`'s
    // `usedToday`, because the SQL function returns a hardcoded 0 from its
    // `p_max_calls <= 0` branch — so the one admission that writes nothing is
    // also the one that cannot report the count.
    let askedDay = "";
    const ledger = new SupabaseUsageLedger(
      gateway({
        embeddingRequestsForDay: async (day) => {
          askedDay = day;
          return 4;
        },
      }),
    );

    expect(await ledger.embeddingRequestsToday()).toBe(4);
    expect(askedDay).toBe(utcDayKey());
  });

  it("surfaces an embedding-count failure instead of reporting zero", async () => {
    // Reporting 0 here would say the day's cap is untouched when it is not.
    const ledger = new SupabaseUsageLedger(
      gateway({
        embeddingRequestsForDay: async () => {
          throw new UsageLedgerFailure("embedding_request_count", "the count query failed");
        },
      }),
    );

    await expect(ledger.embeddingRequestsToday()).rejects.toThrow(/count query failed/);
  });

  it("maps a granted reservation, keeping the id for settlement", async () => {
    const ledger = new SupabaseUsageLedger(
      gateway({
        admitGenerationTokens: async () => ({
          admitted: true,
          reservation_id: "abc",
          spent_tokens: 100,
          reserved_tokens: 200,
          detail: "reserving 600",
        }),
      }),
    );

    const decision = await ledger.admitGeneration(GENERATION_REQUEST);
    expect(decision.admitted).toBe(true);
    if (!decision.admitted) return;
    expect(decision.reservation.id).toBe("abc");
    expect(decision.reservation.reservedTokens).toBe(600);
    expect(decision.spentTokens).toBe(100);
    expect(decision.reservedTokens).toBe(200);
  });

  it("treats a refusal as a refusal, with no reservation to settle", async () => {
    const ledger = new SupabaseUsageLedger(
      gateway({
        admitGenerationTokens: async () => ({
          admitted: false,
          reservation_id: null,
          spent_tokens: 19_500,
          reserved_tokens: 600,
          detail: "only 0 remain",
        }),
      }),
    );

    const decision = await ledger.admitGeneration(GENERATION_REQUEST);
    expect(decision.admitted).toBe(false);
    expect(decision.reservation).toBeNull();
    expect(decision.detail).toBe("only 0 remain");
  });

  it("does not trust an admitted row that carries no reservation id", async () => {
    // Half a response is not a grant: without an id the call could never be
    // reconciled, so it must be refused rather than run unmetered.
    const ledger = new SupabaseUsageLedger(
      gateway({
        admitGenerationTokens: async () => ({
          admitted: true,
          reservation_id: null,
          spent_tokens: 0,
          reserved_tokens: 0,
          detail: "looks fine",
        }),
      }),
    );

    expect((await ledger.admitGeneration(GENERATION_REQUEST)).admitted).toBe(false);
  });

  it("maps the settlement row onto the charge", async () => {
    const ledger = new SupabaseUsageLedger(
      gateway({
        settleReservation: async () => ({
          charged_tokens: "1250",
          reported_tokens: "1250",
          outcome: "reported",
          detail: "settled",
        }),
      }),
    );

    const settled = await ledger.settle(
      { id: "abc", kind: "generation_tokens", reservedTokens: 2000 },
      { promptTokens: 1000, completionTokens: 0, reasoningTokens: 250 },
    );

    expect(settled.chargedTokens).toBe(1250);
    expect(settled.reportedTokens).toBe(1250);
    expect(settled.outcome).toBe("reported");
  });

  it("preserves the provider's report when the settlement row does not echo it", async () => {
    const ledger = new SupabaseUsageLedger(gateway());
    const settled = await ledger.settle(
      { id: "abc", kind: "generation_tokens", reservedTokens: 2000 },
      { promptTokens: 10, completionTokens: 20, reasoningTokens: 30 },
    );
    expect(settled.reportedTokens).toBe(60);
  });

  it("records usage with cost left explicitly unknown", async () => {
    const store = gateway();
    await new SupabaseUsageLedger(store).record(entry({ promptTokens: 10, completionTokens: 4 }));

    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].prompt_tokens).toBe(10);
    expect(store.rows[0].completion_tokens).toBe(4);
    // Inventing a cost without a dated price source would understate spend.
    expect(store.rows[0].estimated_cost_usd).toBeNull();
    expect(store.rows[0].price_source_date).toBeNull();
  });

  it("persists reasoning tokens in their own column now that one exists", async () => {
    // Before migration 0003 the total had to be smuggled inside
    // prompt+completion to survive at all. The total is now an explicit
    // `charged_tokens`, and the components stay readable.
    const row = usageRow(entry({ promptTokens: 417, completionTokens: 21, reasoningTokens: 984 }));

    expect(row.reasoning_tokens).toBe(984);
    expect(row.charged_tokens).toBe(1422);
    expect(row.state).toBe("settled");
    expect(row.kind).toBe("generation_tokens");
    expect(row.day).toBe(utcDayKey());
  });

  it("records the same total the in-memory ledger does, for the same entry", async () => {
    // Guards a real defect: the two ledgers once disagreed, because one added the
    // reasoning component and the other persisted only the visible completion. A
    // mode switch must not change what counts as spend.
    const sample = entry({ promptTokens: 417, completionTokens: 21, reasoningTokens: 984 });

    const memory = new InMemoryUsageLedger();
    await memory.record(sample);

    const store = gateway();
    await new SupabaseUsageLedger(store).record(sample);

    expect(store.rows[0].charged_tokens).toBe(await memory.spentToday());
    expect(await memory.spentToday()).toBe(entryTotalTokens(sample));
  });

  it("propagates a read failure instead of reporting zero spend", async () => {
    const ledger = new SupabaseUsageLedger(
      gateway({
        dayTotals: async () => {
          throw new UsageLedgerFailure("day_totals", "relation does not exist");
        },
      }),
    );

    // Returning 0 here would silently disable the cap, so it must throw.
    await expect(ledger.spentToday()).rejects.toThrow(/relation does not exist/);
  });

  it("propagates an admission failure instead of granting the call", async () => {
    const ledger = new SupabaseUsageLedger(
      gateway({
        admitGenerationTokens: async () => {
          throw new UsageLedgerFailure("admit", "function does not exist");
        },
      }),
    );

    await expect(ledger.admitGeneration(GENERATION_REQUEST)).rejects.toThrow(/does not exist/);
  });

  it("reports its mode as the durable one", () => {
    expect(new SupabaseUsageLedger(gateway()).mode).toBe("supabase");
  });
});

describe("supabase gateway error handling", () => {
  it("sums settled charges and outstanding reservations for the day", async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: async () => ({
            data: [
              { state: "settled", charged_tokens: 100, reserved_tokens: 0 },
              { state: "settled", charged_tokens: "50", reserved_tokens: 0 },
              { state: "reserved", charged_tokens: null, reserved_tokens: 600 },
              { state: "settled", charged_tokens: -5, reserved_tokens: 0 },
            ],
            error: null,
          }),
        }),
      }),
    };

    const totals = await createSupabaseUsageGateway(
      client as unknown as SupabaseClient,
    ).dayTotals(utcDayKey());

    expect(totals.settledTokens).toBe(150);
    expect(totals.reservedTokens).toBe(600);
  });

  it("surfaces a read error so an unreadable ledger is visible", async () => {
    const client = {
      from: () => ({
        select: () => ({
          eq: async () => ({ data: null, error: { message: "column day does not exist" } }),
        }),
      }),
    };

    await expect(
      createSupabaseUsageGateway(client as unknown as SupabaseClient).dayTotals(utcDayKey()),
    ).rejects.toThrow(/column day does not exist/);
  });

  it("surfaces an RPC error and names the migration to check", async () => {
    const client = {
      rpc: async () => ({
        data: null,
        error: { message: "Could not find the function public.horizon_admit_generation_tokens" },
      }),
    };

    await expect(
      createSupabaseUsageGateway(client as unknown as SupabaseClient).admitGenerationTokens({
        budgetTokens: 100,
        reserveTokens: 10,
        provider: "p",
        modelId: null,
        operation: "generate",
      }),
    ).rejects.toThrow(/migration 0003/);
  });

  it("refuses to read a successful response with no row as an admission", async () => {
    const client = { rpc: async () => ({ data: [], error: null }) };

    await expect(
      createSupabaseUsageGateway(client as unknown as SupabaseClient).admitGenerationTokens({
        budgetTokens: 100,
        reserveTokens: 10,
        provider: "p",
        modelId: null,
        operation: "generate",
      }),
    ).rejects.toThrow(/returned no row/);
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

  it("passes the reservation id and the reported figures to the settle function", async () => {
    let captured: Record<string, unknown> = {};
    const client = {
      rpc: async (_fn: string, args: Record<string, unknown>) => {
        captured = args;
        return {
          data: [{ charged_tokens: 5, reported_tokens: 5, outcome: "reported", detail: "" }],
          error: null,
        };
      },
    };

    await createSupabaseUsageGateway(client as unknown as SupabaseClient).settleReservation({
      reservationId: "res-1",
      promptTokens: 3,
      completionTokens: 2,
      reasoningTokens: null,
      failed: true,
      detail: null,
      notBillable: false,
    });

    expect(captured.p_reservation_id).toBe("res-1");
    expect(captured.p_prompt_tokens).toBe(3);
    expect(captured.p_failed).toBe(true);
    expect(captured.p_not_billable).toBe(false);
  });

  it("uses the UTC day key, not a local-time instant, for the day column", () => {
    // utcDayStart is the ISO instant; the column is a plain date. Mixing them
    // would compare a date against a timestamp and silently match nothing.
    expect(utcDayStart()).toMatch(/T00:00:00\.000Z$/);
    expect(utcDayKey()).not.toContain("T");
  });
});
